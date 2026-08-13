import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, stringifyCsv } from "./lib/csv.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, "public");
const config = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));

config.port = Number(process.env.CAMTRAP_PORT || config.port || 4173);
config.manifestCsv = process.env.CAMTRAP_MANIFEST_CSV || config.manifestCsv;
config.workingCsv = process.env.CAMTRAP_WORKING_CSV || config.workingCsv;
config.mediaRoot = process.env.CAMTRAP_MEDIA_ROOT || config.mediaRoot;
config.taxonomyJson = path.resolve(ROOT, process.env.CAMTRAP_TAXONOMY_JSON || config.taxonomyJson);

const IMMUTABLE_FIELDS = [
  "DeploymentID", "EventID", "EventTime", "SamplingStratum", "AuditRandom",
  "ChallengeReasons", "ImportantSpeciesStatus", "Photo1", "Photo2", "Photo3", "Video",
];
const EDITABLE_FIELDS = [
  "PhotoOnlyDecision", "VideoDecision", "VideoAddsAnimal", "FinalDecision", "VisibleClass",
  "EmptyCause", "TaxonCode", "CommonName", "ScientificName", "CountMin", "Visibility",
  "ReviewerConfidence", "ImportantSpeciesFlag", "Annotator", "ReviewStatus", "FirstPassDate",
  "SecondReviewer", "DoubleCheckDate", "Adjudicator", "AdjudicationDate", "Notes",
];
const ALL_FIELDS = [...IMMUTABLE_FIELDS, ...EDITABLE_FIELDS];

const ENUMS = {
  PhotoOnlyDecision: ["", "empty", "animal", "person", "vehicle", "equipment_error", "uncertain"],
  VideoDecision: ["", "empty", "animal", "person", "vehicle", "equipment_error", "uncertain"],
  VideoAddsAnimal: ["", "yes", "no", "not_applicable"],
  FinalDecision: ["", "empty", "animal", "person", "vehicle", "equipment_error", "uncertain"],
  VisibleClass: ["", "empty", "animal", "person", "vehicle", "equipment_error", "uncertain"],
  EmptyCause: ["", "wind_vegetation", "light_shadow", "rain_fog", "camera_motion", "unknown"],
  Visibility: ["", "clear", "partial", "edge", "tiny", "blurred", "night_unclear"],
  ReviewerConfidence: ["", "high", "medium", "low"],
  ImportantSpeciesFlag: ["", "yes", "no", "pending"],
  ReviewStatus: ["", "first_pass", "double_checked", "adjudicated"],
};

const MIME_TYPES = {
  ".avi": "video/x-msvideo",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

let events = [];
let taxonomy = [];
let knownMedia = new Set();
let saveQueue = Promise.resolve();

function jsonResponse(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

function textResponse(response, statusCode, body, type = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function publicEvent(event) {
  const result = {};
  for (const field of ALL_FIELDS) result[field] = event[field] ?? "";
  result.media = Object.fromEntries(
    ["Photo1", "Photo2", "Photo3", "Video"].map((field) => [
      field,
      event[field] ? `/media/${encodeURIComponent(event[field])}` : "",
    ]),
  );
  result.filenameHint = [event.Photo1, event.Photo2, event.Photo3, event.Video]
    .map((name) => extractFilenameHint(name))
    .find(Boolean) || "";
  return result;
}

function extractFilenameHint(filename = "") {
  const stem = filename.replace(/\.[^.]+$/, "");
  const dashIndex = stem.indexOf("-");
  if (dashIndex < 0) return "";
  return stem.slice(dashIndex + 1).trim();
}

async function loadState() {
  const sourceText = await readFile(config.manifestCsv, "utf8");
  const sourceEvents = parseCsv(sourceText);
  if (!sourceEvents.length) throw new Error(`事件清單為空：${config.manifestCsv}`);

  const eventIds = new Set();
  for (const event of sourceEvents) {
    if (!event.EventID || eventIds.has(event.EventID)) {
      throw new Error(`事件清單含空白或重複 EventID：${event.EventID || "(blank)"}`);
    }
    eventIds.add(event.EventID);
  }

  let workingById = new Map();
  if (existsSync(config.workingCsv)) {
    const workingRows = parseCsv(await readFile(config.workingCsv, "utf8"));
    workingById = new Map(workingRows.map((row) => [row.EventID, row]));
  }

  events = sourceEvents.map((source) => {
    const working = workingById.get(source.EventID) || {};
    const merged = {};
    for (const field of IMMUTABLE_FIELDS) merged[field] = source[field] ?? "";
    for (const field of EDITABLE_FIELDS) merged[field] = working[field] ?? source[field] ?? "";
    return merged;
  });
  knownMedia = new Set(events.flatMap((event) => [event.Photo1, event.Photo2, event.Photo3, event.Video]).filter(Boolean));
  taxonomy = JSON.parse(await readFile(config.taxonomyJson, "utf8"));
}

function validatePatch(body) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return ["請求內容必須是物件。"];
  if (typeof body.EventID !== "string" || !events.some((event) => event.EventID === body.EventID)) {
    errors.push("EventID 不存在或格式錯誤。");
  }
  for (const [field, allowed] of Object.entries(ENUMS)) {
    if (field in body && !allowed.includes(String(body[field] ?? ""))) errors.push(`${field} 值不在允許清單內。`);
  }
  if ("CountMin" in body && body.CountMin !== "" && !/^\d+$/.test(String(body.CountMin))) {
    errors.push("CountMin 必須為空白或非負整數。");
  }
  for (const field of ["FirstPassDate", "DoubleCheckDate", "AdjudicationDate"]) {
    if (field in body && body[field] !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(body[field]))) {
      errors.push(`${field} 必須使用 YYYY-MM-DD。`);
    }
  }
  for (const key of Object.keys(body)) {
    if (key !== "EventID" && !EDITABLE_FIELDS.includes(key)) errors.push(`不可修改欄位：${key}`);
  }
  return errors;
}

async function persistEvents() {
  const destination = path.resolve(config.workingCsv);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const backup = `${destination}.backup.csv`;
  await writeFile(temporary, stringifyCsv(events, ALL_FIELDS), "utf8");
  try {
    if (existsSync(destination)) await copyFile(destination, backup);
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("請求內容過大。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_ROOT, relative);
  const prefix = `${path.resolve(PUBLIC_ROOT)}${path.sep}`;
  if (resolved !== path.join(path.resolve(PUBLIC_ROOT), "index.html") && !resolved.startsWith(prefix)) {
    textResponse(response, 403, "Forbidden");
    return;
  }
  try {
    const body = await readFile(resolved);
    const headers = {
      "Content-Type": MIME_TYPES[path.extname(resolved).toLowerCase()] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    };
    if (pathname === "/service-worker.js") headers["Service-Worker-Allowed"] = "/";
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    textResponse(response, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "Not found" : "Server error");
  }
}

async function serveMedia(request, response, encodedName) {
  let filename;
  try {
    filename = decodeURIComponent(encodedName);
  } catch {
    textResponse(response, 400, "Bad media path");
    return;
  }
  if (!knownMedia.has(filename) || path.basename(filename) !== filename) {
    textResponse(response, 404, "Unknown media");
    return;
  }
  const mediaRoot = path.resolve(config.mediaRoot);
  const resolved = path.resolve(mediaRoot, filename);
  if (!resolved.startsWith(`${mediaRoot}${path.sep}`)) {
    textResponse(response, 403, "Forbidden");
    return;
  }
  try {
    const info = await stat(resolved);
    const range = request.headers.range;
    const contentType = MIME_TYPES[path.extname(resolved).toLowerCase()] || "application/octet-stream";
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
        response.end();
        return;
      }
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
      if (start > end || start >= info.size) {
        response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
        response.end();
        return;
      }
      response.writeHead(206, {
        "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${info.size}`,
        "Content-Length": end - start + 1, "Content-Type": contentType, "Cache-Control": "private, max-age=300",
      });
      createReadStream(resolved, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, {
      "Accept-Ranges": "bytes", "Content-Length": info.size, "Content-Type": contentType,
      "Cache-Control": "private, max-age=300",
    });
    createReadStream(resolved).pipe(response);
  } catch (error) {
    textResponse(response, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "Missing media" : "Media error");
  }
}

function statusSummary() {
  const reviewed = events.filter((event) => event.ReviewStatus || event.FinalDecision).length;
  return {
    total: events.length,
    reviewed,
    unreviewed: events.length - reviewed,
    firstPass: events.filter((event) => event.ReviewStatus === "first_pass").length,
    doubleChecked: events.filter((event) => event.ReviewStatus === "double_checked").length,
    adjudicated: events.filter((event) => event.ReviewStatus === "adjudicated").length,
  };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      jsonResponse(response, 200, { ok: true, deploymentId: config.deploymentId, events: events.length });
    } else if (request.method === "GET" && url.pathname === "/api/config") {
      jsonResponse(response, 200, {
        appName: config.appName,
        deploymentId: config.deploymentId,
        sourceManifest: config.manifestCsv,
        workingCsv: config.workingCsv,
        mediaRoot: config.mediaRoot,
        photoFirstWorkflow: true,
      });
    } else if (request.method === "GET" && url.pathname === "/api/events") {
      jsonResponse(response, 200, { events: events.map(publicEvent), status: statusSummary() });
    } else if (request.method === "GET" && url.pathname === "/api/taxonomy") {
      jsonResponse(response, 200, { taxonomy });
    } else if (request.method === "GET" && url.pathname === "/api/status") {
      jsonResponse(response, 200, statusSummary());
    } else if (request.method === "GET" && url.pathname === "/api/export.csv") {
      const csv = stringifyCsv(events, ALL_FIELDS);
      response.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${config.deploymentId}_annotations_working.csv"`,
        "Content-Length": Buffer.byteLength(csv),
        "Cache-Control": "no-store",
      });
      response.end(csv);
    } else if (request.method === "POST" && url.pathname === "/api/annotations") {
      const body = await readRequestBody(request);
      const errors = validatePatch(body);
      if (errors.length) {
        jsonResponse(response, 400, { ok: false, errors });
        return;
      }
      const event = events.find((candidate) => candidate.EventID === body.EventID);
      for (const field of EDITABLE_FIELDS) {
        if (field in body) event[field] = String(body[field] ?? "");
      }
      saveQueue = saveQueue.then(persistEvents, persistEvents);
      await saveQueue;
      jsonResponse(response, 200, { ok: true, event: publicEvent(event), status: statusSummary() });
    } else if (request.method === "GET" && url.pathname.startsWith("/media/")) {
      await serveMedia(request, response, url.pathname.slice("/media/".length));
    } else if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(request, response, url.pathname);
    } else {
      textResponse(response, 405, "Method not allowed");
    }
  } catch (error) {
    console.error(error);
    jsonResponse(response, 500, { ok: false, error: "伺服器處理失敗。", detail: error.message });
  }
});

await loadState();
server.listen(config.port, "127.0.0.1", () => {
  console.log(`${config.appName} 已啟動：http://127.0.0.1:${config.port}`);
  console.log(`事件數：${events.length}`);
  console.log(`工作檔：${config.workingCsv}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
