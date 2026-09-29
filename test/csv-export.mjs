import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, stringifyCsv } from "../lib/csv.mjs";
import { selectExportEvents, exportDisposition, exportEventsCsv } from "../lib/csv-export.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = await mkdtemp(path.join(os.tmpdir(), "camera-trap-export-test-"));
const preview = process.argv.includes("--preview");
const port = preview ? 4199 : 46200 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const origin = "https://nexusintelligent.github.io";
const headers = ["DeploymentID", "EventID", "EventTime", "SourceType", "AIStatus", "AIEventLabels", "AISpecies",
  "Notes", "PhotoFiles", "PhotosPerEvent", "Photo1", "Photo2", "Photo3", "Video", "AIConfidence",
  "AISpeciesConfidence", "AIModelName", "HumanLabels", "FinalDecision", "ReviewStatus", "CommonName",
  "IndividualCountMax", "Annotator", "ReviewedAt", "CorrectionReason"];
const oldBatch = "第一批-森林相機-a1b2c3d4";
const newBatch = "第二批-溪流相機-e5f6a7b8";
const fixtures = [
  { DeploymentID: oldBatch, EventID: "A-01", SourceType: "web_upload", AIStatus: "AI_COMPLETE", AIEventLabels: "animal", AISpecies: "山羌", Notes: '有逗號,以及"引號"\n第二行',
    EventTime: "2026-09-23T04:55:30Z", PhotosPerEvent: "5", PhotoFiles: JSON.stringify(["a/1.jpg", "a/2.jpg", "a/3.jpg", "a/4.jpg", "a/5.jpg"]),
    AIConfidence: "0.9", AISpeciesConfidence: "0.8", AIModelName: "internal-model", HumanLabels: "empty", FinalDecision: "empty",
    ReviewStatus: "CONFLICT", IndividualCountMax: "0", Annotator: "測試覆核者", ReviewedAt: "2026-09-29T04:55:30Z", CorrectionReason: "人工判斷為空觸發" },
  { DeploymentID: oldBatch, EventID: "A-02", SourceType: "web_upload", AIStatus: "AI_PENDING", PhotosPerEvent: "5", PhotoFiles: JSON.stringify(["a/6.jpg", "a/7.jpg"]) },
  { DeploymentID: newBatch, EventID: "B-01", SourceType: "web_upload", AIStatus: "AI_COMPLETE", AIEventLabels: "empty", PhotosPerEvent: "1", PhotoFiles: '["b/1.jpg"]' },
  { DeploymentID: newBatch, EventID: "B-02", SourceType: "web_upload", AIStatus: "FAILED", PhotosPerEvent: "1", PhotoFiles: '["b/2.jpg"]' },
  { DeploymentID: newBatch, EventID: "B-03", SourceType: "web_upload", AIStatus: "AI_COMPLETE", AIEventLabels: "person;vehicle", PhotosPerEvent: "1", PhotoFiles: '["b/3.jpg"]' },
];
let server;
let logs = "";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer() {
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CAMTRAP_PORT: String(port), LOCALAPPDATA: runtime,
      CAMTRAP_MANIFEST_CSV: path.join(runtime, "source.csv"), CAMTRAP_WORKING_CSV: path.join(runtime, "working.csv"),
      CAMTRAP_AUDIT_LOG: path.join(runtime, "audit.jsonl"), CAMTRAP_UPLOADS_ROOT: path.join(runtime, "uploads"),
      CAMTRAP_WEB_EVENTS_CSV: path.join(runtime, "uploads", "events.csv"),
      CAMTRAP_AI_JOBS_ROOT: path.join(runtime, "jobs"), CAMTRAP_AI_MODEL_CACHE: path.join(runtime, "models"),
    },
  });
  server.stdout.on("data", (chunk) => { logs += chunk; });
  server.stderr.on("data", (chunk) => { logs += chunk; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/api/health")).ok) return; } catch { /* Startup. */ }
    await pause(50);
  }
  throw new Error(logs);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const closed = new Promise((resolve) => server.once("exit", resolve));
  server.kill();
  await closed;
}

async function exportCsv(deploymentId) {
  const query = deploymentId === undefined ? "" : `?${new URLSearchParams({ deploymentId })}`;
  const response = await fetch(base + "/api/export.csv" + query, { headers: { Origin: origin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.match(response.headers.get("access-control-expose-headers"), /Content-Disposition/);
  assert.match(response.headers.get("access-control-expose-headers"), /X-CameraTrap-Export-Version/);
  assert.equal(response.headers.get("x-cameratrap-export-version"), "1");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type"), /text\/csv/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "Keep Excel UTF-8 BOM");
  const filename = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(response.headers.get("content-disposition"))[1]);
  assert.ok(filename.includes(deploymentId ?? "all-batches"));
  assert.match(filename, /_\d{8}T\d{9}Z\.csv$/);
  return { rows: parseCsv(bytes.toString("utf8")), filename };
}

try {
  assert.deepEqual(selectExportEvents([], new URLSearchParams()).events, []);
  const photoHeaders = (row) => Object.keys(row).filter((header) => /^照片\d+$/.test(header));
  const snapshot = structuredClone(fixtures);
  const shortGroup = parseCsv(exportEventsCsv([fixtures[1]]))[0];
  assert.deepEqual(photoHeaders(shortGroup), ["照片1", "照片2", "照片3", "照片4", "照片5"], "Keep configured slots for an incomplete group");
  assert.equal(shortGroup["照片5"], "");
  assert.equal(shortGroup["人工判定"], "", "An AI result is not a human review");
  const limitGroup = parseCsv(exportEventsCsv([{ PhotosPerEvent: "100", PhotoFiles: '["one.jpg"]' }]))[0];
  assert.equal(photoHeaders(limitGroup).length, 100);
  assert.equal(limitGroup["照片100"], "");
  for (const value of ["", "0", "-1", "1.5", "101", "Infinity", "NaN"]) {
    assert.equal(photoHeaders(parseCsv(exportEventsCsv([{ PhotosPerEvent: value, PhotoFiles: '["one.jpg"]' }]))[0]).length, 1);
  }
  const wider = parseCsv(exportEventsCsv([{ PhotosPerEvent: "1", PhotoFiles: ["one.jpg", "two.jpg", "three.jpg", "four.jpg"] }]))[0];
  assert.equal(wider["照片4"], "four.jpg", "Actual media must not be truncated by an outdated group setting");
  const legacy = parseCsv(exportEventsCsv([{ PhotoFiles: "invalid-json", Photo1: "old/1.jpg", Photo3: "old/3.jpg",
    FinalDecision: "animal", CommonName: "山羌", CountMin: "2", ReviewStatus: "first_pass", Video: "old/1.mp4" }]))[0];
  assert.equal(legacy["照片1"], "old/1.jpg");
  assert.equal(legacy["照片2"], "");
  assert.equal(legacy["照片3"], "old/3.jpg", "Preserve old numbered slots, including gaps");
  assert.equal(legacy["人工判定"], "動物");
  assert.equal(legacy["人工物種"], "山羌");
  assert.equal(legacy["個體數"], "2");
  assert.equal(legacy["覆核狀態"], "初判完成");
  assert.equal(legacy["影片"], "old/1.mp4");
  const sparse = parseCsv(exportEventsCsv([{ PhotoFiles: '["one.jpg", null, "three.jpg"]' }]))[0];
  assert.equal(sparse["照片2"], "");
  assert.equal(sparse["照片3"], "three.jpg");
  assert.ok(!("照片1" in parseCsv(exportEventsCsv([{ Video: "only.mp4", PhotoFiles: "[]" }]))[0]));
  const flagged = parseCsv(exportEventsCsv([{ AIEventLabels: "animal", AIRepeatDetection: "yes" }]))[0];
  assert.match(flagged["自動判定"], /動物；疑似固定背景誤判/);
  assert.deepEqual(fixtures, snapshot, "Building the export must not mutate source data");
  const emptyCsv = exportEventsCsv([]);
  assert.deepEqual(parseCsv(emptyCsv), []);
  assert.ok(emptyCsv.startsWith("\uFEFF批次編號,事件編號,"));
  assert.ok(!/[A-Za-z]/.test(emptyCsv), "All summary headers are Chinese");
  const hostile = exportDisposition('相機/"\r\nInjected: value*', new Date("2026-09-29T00:00:00Z"));
  assert.ok(!/[\r\n]/.test(hostile));
  const safeFilename = decodeURIComponent(hostile.split("UTF-8''")[1]);
  assert.ok(!/[<>:"/\\|?*\u0000-\u001f]/.test(safeFilename));
  await mkdir(path.join(runtime, "uploads"), { recursive: true });
  await writeFile(path.join(runtime, "source.csv"), stringifyCsv([{ DeploymentID: "既有基準資料", EventID: "G-01", SourceType: "registered",
    Photo1: "old-1.jpg", Photo3: "old-3.jpg", Video: "old-1.mp4" }], headers));
  await writeFile(path.join(runtime, "uploads", "events.csv"), stringifyCsv(fixtures, headers));
  await startServer();
  const config = await (await fetch(base + "/api/config")).json();
  assert.equal(config.csvExport.batchSelection, true);
  assert.equal(config.csvExport.localizedSummary, true);
  assert.equal(config.csvExport.dynamicPhotoColumns, true);
  const a = await exportCsv(oldBatch);
  const b = await exportCsv(newBatch);
  const all = await exportCsv();
  assert.deepEqual(a.rows.map((event) => event["事件編號"]), ["A-01", "A-02"]);
  assert.deepEqual(b.rows.map((event) => event["事件編號"]), ["B-01", "B-02", "B-03"]);
  assert.ok(a.rows.every((event) => event["批次編號"] === oldBatch));
  assert.equal(a.rows[0]["物種候選"], "山羌");
  assert.equal(a.rows[0]["備註"], fixtures[0].Notes);
  assert.equal(a.rows[0]["自動判定"], "動物");
  assert.equal(a.rows[0]["人工判定"], "空觸發", "Keep automatic and human results separate");
  assert.equal(a.rows[0]["覆核狀態"], "結果衝突");
  assert.equal(a.rows[0]["個體數"], "0");
  assert.equal(a.rows[0]["事件時間"], fixtures[0].EventTime);
  assert.equal(a.rows[0]["覆核人員"], fixtures[0].Annotator);
  assert.equal(a.rows[0]["覆核時間"], fixtures[0].ReviewedAt);
  assert.equal(a.rows[0]["修正原因"], fixtures[0].CorrectionReason);
  assert.equal(a.rows[1]["辨識狀態"], "待辨識", "Pending events must not silently disappear");
  assert.equal(b.rows[1]["辨識狀態"], "處理失敗");
  assert.equal(b.rows[2]["自動判定"], "人、車輛");
  assert.deepEqual(photoHeaders(a.rows[0]), ["照片1", "照片2", "照片3", "照片4", "照片5"]);
  assert.equal(a.rows[0]["照片5"], "a/5.jpg");
  assert.equal(a.rows[1]["照片1"], "a/6.jpg");
  assert.equal(a.rows[1]["照片3"], "");
  assert.deepEqual(photoHeaders(b.rows[0]), ["照片1"], "One-photo batch must not inherit other batches' columns");
  assert.ok(!("影片" in a.rows[0]), "No empty video column for photo-only batches");
  assert.equal(Object.keys(a.rows[0]).length, 19, "14 main fields plus five photo columns");
  assert.ok(Object.keys(a.rows[0]).every((header) => !/[A-Za-z]/.test(header)));
  for (const omitted of ["PhotoFiles", "Photo1", "AIModelName", "AIConfidence", "SchemaVersion", "MediaSha256", "SourceRelativePaths"]) {
    assert.ok(!(omitted in a.rows[0]), `${omitted} stays internal`);
  }
  assert.equal(all.rows.length, 6);
  assert.deepEqual(photoHeaders(all.rows[0]), ["照片1", "照片2", "照片3", "照片4", "照片5"]);
  assert.equal(all.rows.find((event) => event["事件編號"] === "B-01")["照片5"], "");
  assert.equal(all.rows.find((event) => event["事件編號"] === "G-01")["影片"], "old-1.mp4");
  const registered = (await exportCsv("既有基準資料")).rows;
  assert.deepEqual(registered.map((event) => event["事件編號"]), ["G-01"]);
  assert.deepEqual(photoHeaders(registered[0]), ["照片1", "照片2", "照片3"]);
  assert.equal(registered[0]["照片3"], "old-3.jpg");
  const internal = (await (await fetch(base + "/api/events")).json()).events.find((event) => event.EventID === "A-01");
  assert.equal(internal.AIModelName, fixtures[0].AIModelName);
  assert.equal(internal.PhotoFiles, fixtures[0].PhotoFiles);
  assert.notEqual(a.filename, b.filename);
  for (const [query, status] of [["deploymentId=missing", 404], ["deploymentId=", 400], ["deploymentId=A&deploymentId=B", 400]]) {
    const response = await fetch(`${base}/api/export.csv?${query}`);
    assert.equal(response.status, status);
    assert.equal((await response.json()).ok, false);
  }
  const annotation = await fetch(base + "/api/annotations", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ EventID: "A-01", Notes: "較早批次的最新人工覆核" }),
  });
  assert.equal(annotation.status, 200, await annotation.text());
  assert.equal((await exportCsv(oldBatch)).rows[0]["備註"], "較早批次的最新人工覆核");
  const persisted = parseCsv(await readFile(path.join(runtime, "uploads", "events.csv"), "utf8"));
  assert.equal(persisted[0].AIModelName, fixtures[0].AIModelName);
  assert.equal(persisted[0].PhotoFiles, fixtures[0].PhotoFiles);
  assert.equal(persisted[0].HumanLabels, "empty");
  assert.ok(!("事件編號" in persisted[0]), "Presentation headers must never replace internal storage fields");
  await stopServer();
  await startServer();
  assert.equal((await exportCsv(oldBatch)).rows[0]["備註"], "較早批次的最新人工覆核");
  assert.equal((await exportCsv(oldBatch)).rows[0]["照片5"], "a/5.jpg");
  assert.equal((await exportCsv(newBatch)).rows.length, 3);
  const script = await readFile(path.join(root, "public", "app.js"), "utf8");
  assert.ok(script.includes('parameters.set("deploymentId",'));
  assert.ok(script.includes("config.csvExport?.localizedSummary"));
  console.log("PASS CSV export: Chinese summary, dynamic 1/5/100 photos, partial/legacy/mixed batches, optional video, review fidelity, unchanged internal data, BOM/quoting, filenames, invalid selection, CORS and restart persistence");
  if (preview) {
    console.log(`UI fixture server ready: ${base}`);
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  }
} finally {
  await stopServer();
  await rm(runtime, { recursive: true, force: true });
}
