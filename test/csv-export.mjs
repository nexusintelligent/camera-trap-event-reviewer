import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, stringifyCsv } from "../lib/csv.mjs";
import { selectExportEvents, exportDisposition } from "../lib/csv-export.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = await mkdtemp(path.join(os.tmpdir(), "camera-trap-export-test-"));
const preview = process.argv.includes("--preview");
const port = preview ? 4199 : 46200 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const origin = "https://nexusintelligent.github.io";
const headers = ["DeploymentID", "EventID", "SourceType", "AIStatus", "AIEventLabels", "AISpecies", "Notes", "PhotoFiles", "Photo1", "Photo2", "Photo3"];
const oldBatch = "第一批-森林相機-a1b2c3d4";
const newBatch = "第二批-溪流相機-e5f6a7b8";
const fixtures = [
  { DeploymentID: oldBatch, EventID: "A-01", SourceType: "web_upload", AIStatus: "AI_COMPLETE", AIEventLabels: "animal", AISpecies: "山羌", Notes: '有逗號,以及"引號"\n第二行', PhotoFiles: "[]" },
  { DeploymentID: oldBatch, EventID: "A-02", SourceType: "web_upload", AIStatus: "AI_PENDING", PhotoFiles: "[]" },
  { DeploymentID: newBatch, EventID: "B-01", SourceType: "web_upload", AIStatus: "AI_COMPLETE", AIEventLabels: "empty", PhotoFiles: "[]" },
  { DeploymentID: newBatch, EventID: "B-02", SourceType: "web_upload", AIStatus: "FAILED", PhotoFiles: "[]" },
  { DeploymentID: newBatch, EventID: "B-03", SourceType: "web_upload", AIStatus: "AI_COMPLETE", AIEventLabels: "person", PhotoFiles: "[]" },
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
  const hostile = exportDisposition('相機/"\r\nInjected: value*', new Date("2026-09-29T00:00:00Z"));
  assert.ok(!/[\r\n]/.test(hostile));
  const safeFilename = decodeURIComponent(hostile.split("UTF-8''")[1]);
  assert.ok(!/[<>:"/\\|?*\u0000-\u001f]/.test(safeFilename));
  await mkdir(path.join(runtime, "uploads"), { recursive: true });
  await writeFile(path.join(runtime, "source.csv"), stringifyCsv([{ DeploymentID: "既有基準資料", EventID: "G-01", SourceType: "registered" }], headers));
  await writeFile(path.join(runtime, "uploads", "events.csv"), stringifyCsv(fixtures, headers));
  await startServer();
  const config = await (await fetch(base + "/api/config")).json();
  assert.equal(config.csvExport.batchSelection, true);
  const a = await exportCsv(oldBatch);
  const b = await exportCsv(newBatch);
  const all = await exportCsv();
  assert.deepEqual(a.rows.map((event) => event.EventID), ["A-01", "A-02"]);
  assert.deepEqual(b.rows.map((event) => event.EventID), ["B-01", "B-02", "B-03"]);
  assert.ok(a.rows.every((event) => event.DeploymentID === oldBatch));
  assert.equal(a.rows[0].AISpecies, "山羌");
  assert.equal(a.rows[0].Notes, fixtures[0].Notes);
  assert.equal(a.rows[1].AIStatus, "AI_PENDING", "Pending events must not silently disappear");
  assert.equal(b.rows[1].AIStatus, "FAILED");
  assert.equal(all.rows.length, 6);
  assert.deepEqual((await exportCsv("既有基準資料")).rows.map((event) => event.EventID), ["G-01"]);
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
  assert.equal((await exportCsv(oldBatch)).rows[0].Notes, "較早批次的最新人工覆核");
  await stopServer();
  await startServer();
  assert.equal((await exportCsv(oldBatch)).rows[0].Notes, "較早批次的最新人工覆核");
  assert.equal((await exportCsv(newBatch)).rows.length, 3);
  const script = await readFile(path.join(root, "public", "app.js"), "utf8");
  assert.ok(script.includes('parameters.set("deploymentId",'));
  console.log("PASS CSV export: older/newer/all/registered batches, isolation, Unicode filenames, BOM, saved review, invalid selection, CORS and restart persistence");
  if (preview) {
    console.log(`UI fixture server ready: ${base}`);
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  }
} finally {
  await stopServer();
  await rm(runtime, { recursive: true, force: true });
}
