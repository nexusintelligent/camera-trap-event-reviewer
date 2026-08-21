import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseCsv, stringifyCsv } from "./lib/csv.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, "public");
const config = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));

config.port = Number(process.env.CAMTRAP_PORT || config.port || 4173);
config.manifestCsv = process.env.CAMTRAP_MANIFEST_CSV || config.manifestCsv;
config.workingCsv = process.env.CAMTRAP_WORKING_CSV || config.workingCsv;
config.auditLog = process.env.CAMTRAP_AUDIT_LOG || config.auditLog
  || path.join(path.dirname(config.workingCsv), `${config.deploymentId}_annotation_audit_v2.0.jsonl`);
config.mediaRoot = process.env.CAMTRAP_MEDIA_ROOT || config.mediaRoot;
config.taxonomyJson = path.resolve(ROOT, process.env.CAMTRAP_TAXONOMY_JSON || config.taxonomyJson);
config.ai ||= {};
const expandEnvironmentVariables = (value) => String(value || "").replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
const defaultAiPython = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA || ROOT, "CameraTrapReviewer", "Python311", "python.exe")
  : path.join(ROOT, ".venv-ai311", "bin", "python");
config.ai.pythonPath = path.resolve(ROOT, expandEnvironmentVariables(process.env.CAMTRAP_AI_PYTHON || config.ai.pythonPath || defaultAiPython));
config.ai.modelCacheRoot = path.resolve(ROOT, expandEnvironmentVariables(
  process.env.CAMTRAP_AI_MODEL_CACHE || config.ai.modelCacheRoot || path.join(path.dirname(config.ai.pythonPath), "model-cache"),
));
config.ai.jobsRoot = path.resolve(process.env.CAMTRAP_AI_JOBS_ROOT || config.ai.jobsRoot || path.join(ROOT, "ai_jobs"));
config.ai.country = process.env.CAMTRAP_AI_COUNTRY || config.ai.country || "";
config.ai.detectorModel = process.env.CAMTRAP_AI_DETECTOR_MODEL || config.ai.detectorModel || "MDv1000-redwood";
config.ai.megadetectorVersion ||= "unknown";
config.ai.speciesnetVersion ||= "unknown";
config.ai.detectionThresholdForClassification = Number(config.ai.detectionThresholdForClassification ?? 0.15);
config.ai.detectionThresholdForOutput = Number(config.ai.detectionThresholdForOutput ?? 0.01);
config.ai.timeSampleSeconds = Number(config.ai.timeSampleSeconds ?? 1);
config.allowedBrowserOrigins = new Set([
  ...(Array.isArray(config.allowedBrowserOrigins) ? config.allowedBrowserOrigins : []),
  ...(process.env.CAMTRAP_ALLOWED_ORIGINS || "").split(","),
].map((value) => value.trim()).filter(Boolean));
config.webUploads ||= {};
config.webUploads.root = path.resolve(ROOT, expandEnvironmentVariables(
  process.env.CAMTRAP_UPLOADS_ROOT || config.webUploads.root || path.join(ROOT, "web-uploads"),
));
config.webUploads.mediaRoot = path.join(config.webUploads.root, "media");
config.webUploads.sessionsRoot = path.join(config.webUploads.root, "sessions");
config.webUploads.eventsCsv = path.resolve(ROOT, expandEnvironmentVariables(
  process.env.CAMTRAP_WEB_EVENTS_CSV || config.webUploads.eventsCsv || path.join(config.webUploads.root, "web-events.csv"),
));
config.webUploads.maxFilesPerImport = Number(config.webUploads.maxFilesPerImport ?? 5000);
config.webUploads.maxFileBytes = Number(config.webUploads.maxFileBytes ?? 4_294_967_296);
config.webUploads.eventGapSeconds = Number(config.webUploads.eventGapSeconds ?? 120);
const AI_TRIAGE_VERSION = `triage-v1.2@${config.ai.detectionThresholdForClassification}`;

const configuredWorkingCsv = path.resolve(ROOT, config.workingCsv);
const configuredAuditLog = path.resolve(ROOT, config.auditLog);
config.workingCsv = configuredWorkingCsv;
config.auditLog = configuredAuditLog;
config.storageMode = "configured";
config.storageNotice = "";

async function prepareWritableAnnotationStorage() {
  const directory = path.dirname(configuredWorkingCsv);
  const probe = path.join(directory, `.camera-trap-write-probe-${process.pid}-${Date.now()}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probe, "", { encoding: "utf8", flag: "wx" });
    await unlink(probe);
  } catch (error) {
    await unlink(probe).catch(() => {});
    if (!["EACCES", "EPERM", "EROFS"].includes(error?.code)) throw error;

    const fallbackRoot = path.join(ROOT, "local-data");
    const fallbackWorkingCsv = path.join(fallbackRoot, path.basename(configuredWorkingCsv));
    const fallbackAuditLog = path.join(fallbackRoot, path.basename(configuredAuditLog));
    await mkdir(fallbackRoot, { recursive: true });
    if (!existsSync(fallbackWorkingCsv) && existsSync(configuredWorkingCsv)) {
      await copyFile(configuredWorkingCsv, fallbackWorkingCsv);
    }
    config.workingCsv = fallbackWorkingCsv;
    config.auditLog = fallbackAuditLog;
    config.storageMode = "local-fallback";
    config.storageNotice = "Configured annotation storage is read-only; using a local working copy.";
  }
}

await prepareWritableAnnotationStorage();

async function prepareWritableAiJobsStorage() {
  const configuredJobsRoot = path.resolve(config.ai.jobsRoot);
  const probe = path.join(configuredJobsRoot, `.camera-trap-write-probe-${process.pid}-${Date.now()}`);
  config.ai.jobsRoot = configuredJobsRoot;
  config.ai.jobsStorageMode = "configured";
  try {
    await mkdir(configuredJobsRoot, { recursive: true });
    await writeFile(probe, "", { encoding: "utf8", flag: "wx" });
    await unlink(probe);
  } catch (error) {
    await unlink(probe).catch(() => {});
    if (!["EACCES", "EPERM", "EROFS"].includes(error?.code)) throw error;
    config.ai.jobsRoot = path.join(ROOT, "local-data", "ai-jobs");
    config.ai.jobsStorageMode = "local-fallback";
    await mkdir(config.ai.jobsRoot, { recursive: true });
  }
}

await prepareWritableAiJobsStorage();

async function prepareWritableWebUploadStorage() {
  const configuredRoot = path.resolve(config.webUploads.root);
  const configuredEventsCsv = path.resolve(config.webUploads.eventsCsv);
  const probe = path.join(configuredRoot, `.camera-trap-write-probe-${process.pid}-${Date.now()}`);
  config.webUploads.storageMode = "configured";
  config.webUploads.storageNotice = "";
  try {
    await mkdir(configuredRoot, { recursive: true });
    await writeFile(probe, "", { encoding: "utf8", flag: "wx" });
    await unlink(probe);
  } catch (error) {
    await unlink(probe).catch(() => {});
    if (!["EACCES", "EPERM", "EROFS"].includes(error?.code)) throw error;

    const fallbackRoot = path.join(ROOT, "local-data", "web-uploads");
    const fallbackEventsCsv = path.join(fallbackRoot, path.basename(configuredEventsCsv));
    await mkdir(fallbackRoot, { recursive: true });
    if (!existsSync(fallbackEventsCsv) && existsSync(configuredEventsCsv)) {
      await copyFile(configuredEventsCsv, fallbackEventsCsv);
    }
    config.webUploads.root = fallbackRoot;
    config.webUploads.mediaRoot = path.join(fallbackRoot, "media");
    config.webUploads.sessionsRoot = path.join(fallbackRoot, "sessions");
    config.webUploads.eventsCsv = fallbackEventsCsv;
    config.webUploads.storageMode = "local-fallback";
    config.webUploads.storageNotice = "Configured web-upload storage is read-only; using project-local storage.";
  }
}

await prepareWritableWebUploadStorage();

const IMMUTABLE_FIELDS = [
  "DeploymentID", "EventID", "EventTime", "SamplingStratum", "AuditRandom",
  "ChallengeReasons", "ImportantSpeciesStatus", "SourceType", "SourceRelativePaths", "MediaSha256",
  "Photo1", "Photo2", "Photo3", "Video",
];
const AI_FIELDS = [
  "AIStatus", "AIEventLabels", "AISpecies", "AISpeciesConfidence", "AIConfidence", "AIModelName",
  "AIModelVersion", "AIProcessedAt", "AIError",
];
const EDITABLE_FIELDS = [
  "PhotoOnlyDecision", "VideoDecision", "VideoAddsAnimal", "FinalDecision", "VisibleClass",
  "EmptyCause", "TaxonCode", "CommonName", "ScientificName", "CountMin", "Visibility",
  "ReviewerConfidence", "ImportantSpeciesFlag", "Annotator", "ReviewStatus", "FirstPassDate",
  "SecondReviewer", "DoubleCheckDate", "Adjudicator", "AdjudicationDate", "Notes",
  "HumanLabels", "IndividualCountMax", "AdditionalTaxonCodes", "CorrectionReason", "TaxonomyVersion",
];
const AUDIT_FIELDS = ["ReviewedAt", "LastModifiedAt", "LastModifiedBy", "SchemaVersion"];
const ALL_FIELDS = [...IMMUTABLE_FIELDS, ...AI_FIELDS, ...EDITABLE_FIELDS, ...AUDIT_FIELDS];

const ENUMS = {
  PhotoOnlyDecision: ["", "empty", "animal", "person", "vehicle", "equipment_error", "uncertain"],
  VideoDecision: ["", "empty", "animal", "person", "vehicle", "equipment_error", "uncertain"],
  VideoAddsAnimal: ["", "yes", "no", "not_applicable"],
  FinalDecision: ["", "empty", "animal", "person", "vehicle", "mixed", "equipment_error", "uncertain"],
  VisibleClass: ["", "empty", "animal", "person", "vehicle", "mixed", "equipment_error", "uncertain"],
  EmptyCause: ["", "wind_vegetation", "light_shadow", "rain_fog", "camera_motion", "unknown"],
  Visibility: ["", "clear", "partial", "edge", "tiny", "blurred", "night_unclear"],
  ReviewerConfidence: ["", "high", "medium", "low"],
  ImportantSpeciesFlag: ["", "yes", "no", "pending"],
  ReviewStatus: [
    "", "first_pass", "double_checked", "adjudicated",
    "AI_PENDING", "AI_RUNNING", "AI_COMPLETE", "NEEDS_REVIEW", "HUMAN_CONFIRMED",
    "UNCERTAIN", "CONFLICT", "FAILED",
  ],
};
const HUMAN_LABELS = new Set(["empty", "animal", "person", "vehicle", "equipment_error", "uncertain"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".avi", ".mp4", ".mov"]);
const UPLOAD_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

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
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

let events = [];
let taxonomy = [];
let mediaPaths = new Map();
let saveQueue = Promise.resolve();
let aiRunQueue = Promise.resolve();
let aiRuntimeStatus = null;
const aiJobs = new Map();
let aiQueuePaused = false;
let aiResumeWaiters = [];
let aiBatchPreference = { mode: "fast", identifySpecies: false };
const importSessions = new Map();
const SPECIES_RESULT_VERSION = "species-result-v2.1";
const CHINESE_TAXON_NAMES = new Map(Object.entries({
  "animal": "未知動物（待人工確認）",
  "mammal": "哺乳類",
  "bird": "鳥類",
  "carnivorous mammal": "食肉目",
  "rodent": "齧齒目",
  "civet genet family": "靈貓科",
  "masked palm civet": "白鼻心",
  "ferret badger species": "鼬獾屬",
  "weasel family": "鼬科",
  "procyonidae family": "浣熊科",
  "possum family": "負鼠科",
  "old world porcupine family": "豪豬科",
  "crab-eating mongoose": "食蟹獴",
  "peromyscus species": "白足鼠屬",
  "greater hog badger": "豬獾",
  "muntjac species": "麂屬",
  "rabbit and hare family": "兔科",
  "phasianidae family": "雉科",
  "bat": "蝙蝠類",
  "nutria": "海狸鼠",
  "north american river otter": "北美水獺",
}).map(([name, translation]) => [normalizedTaxonText(name), translation]));

function isWebWorkspaceEvent(event) {
  return event?._source === "web" || event?.SourceType === "web_upload";
}

function webWorkspaceEvents() {
  return events.filter(isWebWorkspaceEvent);
}

function isAllowedBrowserOrigin(origin) {
  if (!origin) return false;
  if (config.allowedBrowserOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

function applyCorsHeaders(request, response) {
  const origin = request.headers.origin;
  if (!isAllowedBrowserOrigin(origin)) return false;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  response.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Disposition, Content-Range");
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  return true;
}

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

function initializeEvent(source, working = {}, sourceKind = "registered") {
  const merged = {};
  for (const field of IMMUTABLE_FIELDS) merged[field] = source[field] ?? "";
  for (const field of AI_FIELDS) merged[field] = working[field] ?? source[field] ?? "";
  for (const field of EDITABLE_FIELDS) merged[field] = working[field] ?? source[field] ?? "";
  for (const field of AUDIT_FIELDS) merged[field] = working[field] ?? source[field] ?? "";
  if (!merged.SourceType) merged.SourceType = sourceKind === "web" ? "web_upload" : "registered";
  if (!merged.AIStatus) merged.AIStatus = "AI_PENDING";
  if (!merged.HumanLabels && merged.FinalDecision) merged.HumanLabels = merged.FinalDecision;
  if (!merged.IndividualCountMax && merged.CountMin) merged.IndividualCountMax = merged.CountMin;
  if (!merged.TaxonomyVersion) merged.TaxonomyVersion = "taxonomy_v1.0";
  merged.SchemaVersion = "2.1";
  Object.defineProperty(merged, "_source", { value: sourceKind, writable: true, enumerable: false });
  return merged;
}

function pathInside(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`媒體路徑超出允許範圍：${relativePath}`);
  return resolved;
}

function registerEventMedia(event) {
  for (const field of ["Photo1", "Photo2", "Photo3", "Video"]) {
    const token = event[field];
    if (!token) continue;
    if (event._source === "web") {
      const normalized = String(token).replace(/\\/g, "/");
      if (normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new Error(`網頁匯入媒體代碼格式錯誤：${token}`);
      }
      mediaPaths.set(token, pathInside(config.webUploads.mediaRoot, normalized));
    } else {
      if (path.basename(token) !== token) throw new Error(`既有媒體檔名格式錯誤：${token}`);
      mediaPaths.set(token, pathInside(config.mediaRoot, token));
    }
  }
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

  const registeredEvents = sourceEvents.map((source) => initializeEvent(source, workingById.get(source.EventID) || {}, "registered"));
  const webRows = existsSync(config.webUploads.eventsCsv)
    ? parseCsv(await readFile(config.webUploads.eventsCsv, "utf8"))
    : [];
  const allEventIds = new Set(registeredEvents.map((event) => event.EventID));
  const webEvents = webRows.map((row) => {
    if (!row.EventID || allEventIds.has(row.EventID)) throw new Error(`網頁匯入事件含空白或重複 EventID：${row.EventID || "(blank)"}`);
    allEventIds.add(row.EventID);
    return initializeEvent(row, row, "web");
  });
  events = [...registeredEvents, ...webEvents];
  for (const event of events) {
    if (event.AIStatus === "AI_RUNNING") {
      event.AIStatus = "AI_PENDING";
      event.AIError = "上次服務中斷；可由批次辨識自動接續。";
    }
  }
  mediaPaths = new Map();
  for (const event of events) registerEventMedia(event);
  taxonomy = JSON.parse(await readFile(config.taxonomyJson, "utf8"));
}

function validatePatch(body) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return ["請求內容必須是物件。"];
  const current = events.find((event) => event.EventID === body.EventID);
  if (typeof body.EventID !== "string" || !current) {
    errors.push("EventID 不存在或格式錯誤。");
  }
  for (const [field, allowed] of Object.entries(ENUMS)) {
    if (field in body && !allowed.includes(String(body[field] ?? ""))) errors.push(`${field} 值不在允許清單內。`);
  }
  if ("HumanLabels" in body) {
    const labels = String(body.HumanLabels || "").split(";").map((label) => label.trim()).filter(Boolean);
    if (labels.some((label) => !HUMAN_LABELS.has(label))) errors.push("HumanLabels 含未允許的類別。");
    if (labels.includes("empty") && labels.length > 1) errors.push("empty 不可與其他事件類別同時存在。");
    if (new Set(labels).size !== labels.length) errors.push("HumanLabels 不可重複。");
    if (labels.includes("animal") && !String(body.TaxonCode ?? current?.TaxonCode ?? "").trim()) {
      errors.push("動物事件必須填物種代碼；無法判斷時請使用 ANIMAL_UNKNOWN。");
    }
    const aiLabels = String(current?.AIEventLabels || "").split(";").filter(Boolean).sort().join(";");
    const humanLabels = [...labels].sort().join(";");
    if (aiLabels && aiLabels !== humanLabels && !String(body.CorrectionReason ?? current?.CorrectionReason ?? "").trim()) {
      errors.push("人工答案與 AI 答案不同時，必須填寫修正原因。");
    }
  }
  if ("CountMin" in body && body.CountMin !== "" && !/^\d+$/.test(String(body.CountMin))) {
    errors.push("CountMin 必須為空白或非負整數。");
  }
  if ("IndividualCountMax" in body && body.IndividualCountMax !== "" && !/^\d+$/.test(String(body.IndividualCountMax))) {
    errors.push("IndividualCountMax 必須為空白或非負整數。");
  }
  if ("AdditionalTaxonCodes" in body) {
    const codes = String(body.AdditionalTaxonCodes || "").split(";").map((code) => code.trim()).filter(Boolean);
    if (codes.some((code) => !/^[A-Z0-9_.-]+$/.test(code))) errors.push("其他物種代碼格式錯誤。");
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

function changedFields(before, after) {
  return EDITABLE_FIELDS.filter((field) => String(before[field] ?? "") !== String(after[field] ?? ""));
}

async function appendAuditEntry(before, after) {
  const changed = changedFields(before, after);
  if (!changed.length) return;
  const destination = path.resolve(config.auditLog);
  await mkdir(path.dirname(destination), { recursive: true });
  const entry = {
    schemaVersion: "2.1",
    eventId: after.EventID,
    deploymentId: after.DeploymentID,
    changedAt: after.LastModifiedAt,
    changedBy: after.LastModifiedBy || "UNKNOWN",
    correctionReason: after.CorrectionReason || "",
    changedFields: changed,
    before: Object.fromEntries(changed.map((field) => [field, before[field] ?? ""])),
    after: Object.fromEntries(changed.map((field) => [field, after[field] ?? ""])),
  };
  await appendFile(destination, `${JSON.stringify(entry)}\n`, "utf8");
}

async function persistCsv(destinationPath, rows) {
  const destination = path.resolve(destinationPath);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const backup = `${destination}.backup.csv`;
  await writeFile(temporary, stringifyCsv(rows, ALL_FIELDS), "utf8");
  try {
    if (existsSync(destination)) await copyFile(destination, backup);
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function persistEvents(sourceKind = "all") {
  if (sourceKind === "all" || sourceKind === "registered") {
    await persistCsv(config.workingCsv, events.filter((event) => event._source !== "web"));
  }
  if (sourceKind === "all" || sourceKind === "web") {
    await persistCsv(config.webUploads.eventsCsv, events.filter((event) => event._source === "web"));
  }
}

function persistEvent(event) {
  return persistEvents(event?._source === "web" ? "web" : "registered");
}

async function readRequestBody(request, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("請求內容過大。"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function requestError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function normalizedUploadPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").normalize("NFC");
  const parts = normalized.split("/");
  if (!normalized || normalized.length > 600 || parts.some((part) => !part || part === "." || part === ".." || /[\0-\x1f]/.test(part))) {
    throw requestError(400, `媒體相對路徑格式錯誤：${value || "(blank)"}`);
  }
  return normalized;
}

function normalizedDeploymentLabel(value) {
  return String(value || "網頁匯入")
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "WEB";
}

function validateImportManifest(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.media)) throw requestError(400, "匯入清單格式錯誤。");
  if (!body.media.length) throw requestError(400, "匯入清單沒有媒體檔案。");
  if (body.media.length > config.webUploads.maxFilesPerImport) {
    throw requestError(413, `單次最多可匯入 ${config.webUploads.maxFilesPerImport} 個檔案。`);
  }
  const seen = new Set();
  return body.media.map((raw, index) => {
    const relativePath = normalizedUploadPath(raw.relativePath || raw.filename);
    if (seen.has(relativePath)) throw requestError(400, `匯入清單含重複路徑：${relativePath}`);
    seen.add(relativePath);
    const filename = path.posix.basename(relativePath);
    const extension = path.extname(filename).toLowerCase();
    if (!UPLOAD_EXTENSIONS.has(extension)) throw requestError(400, `不支援的媒體格式：${filename}`);
    const size = Number(raw.size);
    if (!Number.isSafeInteger(size) || size <= 0) throw requestError(400, `檔案大小格式錯誤：${filename}`);
    if (size > config.webUploads.maxFileBytes) throw requestError(413, `檔案超過單檔上限：${filename}`);
    const sha256 = String(raw.sha256 || "SERVER_CALCULATED").toLowerCase();
    if (!["server_calculated", "unavailable"].includes(sha256) && !/^[a-f0-9]{64}$/.test(sha256)) {
      throw requestError(400, `SHA-256 格式錯誤：${filename}`);
    }
    const lastModified = new Date(raw.lastModified || 0);
    return {
      index,
      relativePath,
      filename,
      extension,
      size,
      mimeType: String(raw.mimeType || MIME_TYPES[extension] || "application/octet-stream").slice(0, 120),
      lastModified: Number.isNaN(lastModified.getTime()) ? "" : lastModified.toISOString(),
      clientSha256: sha256,
      serverSha256: "",
      storedName: `${String(index + 1).padStart(6, "0")}-${filename.replace(/[^\p{L}\p{N}_.-]+/gu, "-").slice(-180)}`,
      mediaToken: "",
      uploaded: false,
    };
  });
}

function publicImportSession(session) {
  return {
    importId: session.importId,
    deploymentId: session.deploymentId,
    sourceLabel: session.sourceLabel,
    status: session.status,
    createdAt: session.createdAt,
    mediaCount: session.media.length,
    uploadedCount: session.media.filter((item) => item.uploaded).length,
    totalBytes: session.totalBytes,
    eventIds: session.eventIds || [],
  };
}

async function persistImportSession(session) {
  await mkdir(config.webUploads.sessionsRoot, { recursive: true });
  const destination = pathInside(config.webUploads.sessionsRoot, `${session.importId}.json`);
  await writeFile(destination, JSON.stringify(session, null, 2), "utf8");
}

async function getImportSession(importId) {
  if (!/^IMP-[A-Za-z0-9-]+$/.test(importId)) return null;
  if (importSessions.has(importId)) return importSessions.get(importId);
  const filename = pathInside(config.webUploads.sessionsRoot, `${importId}.json`);
  if (!existsSync(filename)) return null;
  const session = JSON.parse(await readFile(filename, "utf8"));
  if (session.importId !== importId || !Array.isArray(session.media)) throw requestError(409, "匯入工作紀錄損壞。");
  importSessions.set(importId, session);
  return session;
}

async function cancelImportSession(session) {
  if (session.status === "COMPLETE") {
    throw requestError(409, "此批次已建立事件；請改用「清除上傳工作區」。");
  }
  const importMediaRoot = pathInside(config.webUploads.mediaRoot, session.importId);
  const sessionFile = pathInside(config.webUploads.sessionsRoot, `${session.importId}.json`);
  await rm(importMediaRoot, { recursive: true, force: true });
  await unlink(sessionFile).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  importSessions.delete(session.importId);
}

async function createImportSession(body) {
  const media = validateImportManifest(body);
  const importId = `IMP-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const sourceLabel = normalizedDeploymentLabel(body.deploymentName);
  const deploymentId = `${sourceLabel}-${importId.slice(-8)}`;
  const session = {
    schemaVersion: "2.1",
    importId,
    deploymentId,
    sourceLabel,
    status: "WAITING_UPLOAD",
    createdAt: new Date().toISOString(),
    totalBytes: media.reduce((sum, item) => sum + item.size, 0),
    media,
    eventIds: [],
  };
  importSessions.set(importId, session);
  await persistImportSession(session);
  return session;
}

async function validateMediaSignature(filename, extension) {
  const handle = await open(filename, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    const ascii = (start, end) => head.subarray(start, end).toString("ascii");
    if ([".jpg", ".jpeg"].includes(extension)) return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    if (extension === ".png") return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (extension === ".webp") return head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    if (extension === ".avi") return head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 11) === "AVI";
    if ([".mp4", ".mov"].includes(extension)) return head.length >= 12 && ascii(4, 8) === "ftyp";
    return false;
  } finally {
    await handle.close();
  }
}

async function receiveImportFile(request, session, index) {
  if (!Number.isInteger(index) || index < 0 || index >= session.media.length) throw requestError(404, "找不到指定的匯入檔案。");
  if (session.status === "COMPLETE") throw requestError(409, "此匯入工作已完成。");
  const item = session.media[index];
  if (item.uploaded) return item;
  const contentLength = Number(request.headers["content-length"] || item.size);
  if (!Number.isSafeInteger(contentLength) || contentLength !== item.size) throw requestError(400, `上傳大小與清單不符：${item.filename}`);
  const importMediaRoot = pathInside(config.webUploads.mediaRoot, session.importId);
  await mkdir(importMediaRoot, { recursive: true });
  const destination = pathInside(importMediaRoot, item.storedName);
  const temporary = `${destination}.part-${process.pid}-${Date.now()}`;
  const hash = createHash("sha256");
  let received = 0;
  try {
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > item.size || received > config.webUploads.maxFileBytes) {
          callback(requestError(413, `上傳內容超過宣告大小：${item.filename}`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(request, verifier, createWriteStream(temporary, { flags: "wx" }));
    if (received !== item.size) throw requestError(400, `上傳內容不完整：${item.filename}`);
    const serverSha256 = hash.digest("hex");
    if (/^[a-f0-9]{64}$/.test(item.clientSha256) && item.clientSha256 !== serverSha256) {
      throw requestError(400, `SHA-256 驗證失敗：${item.filename}`);
    }
    if (!(await validateMediaSignature(temporary, item.extension))) throw requestError(400, `檔案內容與副檔名不符：${item.filename}`);
    await rename(temporary, destination);
    item.serverSha256 = serverSha256;
    item.mediaToken = `${session.importId}/${item.storedName}`;
    item.uploaded = true;
    session.status = "UPLOADING";
    await persistImportSession(session);
    return item;
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function groupImportedMedia(media) {
  const sorted = [...media].sort((left, right) => {
    const leftFolder = path.posix.dirname(left.relativePath);
    const rightFolder = path.posix.dirname(right.relativePath);
    const folderOrder = leftFolder.localeCompare(rightFolder, "zh-Hant", { numeric: true });
    if (folderOrder) return folderOrder;
    const timeOrder = new Date(left.lastModified || 0).getTime() - new Date(right.lastModified || 0).getTime();
    return timeOrder || left.relativePath.localeCompare(right.relativePath, "zh-Hant", { numeric: true });
  });
  const groups = [];
  let current = [];
  const flush = () => { if (current.length) groups.push(current); current = []; };
  for (const item of sorted) {
    const folder = path.posix.dirname(item.relativePath);
    const previous = current.at(-1);
    const photoCount = current.filter((entry) => IMAGE_EXTENSIONS.has(entry.extension)).length;
    const videoCount = current.filter((entry) => VIDEO_EXTENSIONS.has(entry.extension)).length;
    const gapSeconds = previous
      ? Math.abs(new Date(item.lastModified || 0).getTime() - new Date(previous.lastModified || 0).getTime()) / 1000
      : 0;
    const startNew = current.length > 0 && (
      path.posix.dirname(previous.relativePath) !== folder
      || gapSeconds > config.webUploads.eventGapSeconds
      || current.length >= 4
      || (IMAGE_EXTENSIONS.has(item.extension) && photoCount >= 3)
      || (VIDEO_EXTENSIONS.has(item.extension) && videoCount >= 1)
    );
    if (startNew) flush();
    current.push(item);
  }
  flush();
  return groups;
}

function importedEventFromGroup(session, group, index) {
  const photos = group.filter((item) => IMAGE_EXTENSIONS.has(item.extension)).slice(0, 3);
  const video = group.find((item) => VIDEO_EXTENSIONS.has(item.extension));
  const source = Object.fromEntries(ALL_FIELDS.map((field) => [field, ""]));
  source.DeploymentID = session.deploymentId;
  source.EventID = `${session.deploymentId}-E${String(index + 1).padStart(4, "0")}`;
  source.EventTime = group.map((item) => item.lastModified).filter(Boolean).sort()[0] || session.createdAt;
  source.SamplingStratum = "web_upload";
  source.AuditRandom = "0";
  source.ChallengeReasons = photos.length === 3 && video ? "" : "incomplete_pairing";
  source.SourceType = "web_upload";
  source.SourceRelativePaths = group.map((item) => item.relativePath).join(";");
  source.MediaSha256 = group.map((item) => `${item.filename}=${item.serverSha256}`).join(";");
  source.Photo1 = photos[0]?.mediaToken || "";
  source.Photo2 = photos[1]?.mediaToken || "";
  source.Photo3 = photos[2]?.mediaToken || "";
  source.Video = video?.mediaToken || "";
  source.AIStatus = "AI_PENDING";
  source.ReviewStatus = "NEEDS_REVIEW";
  source.TaxonomyVersion = "taxonomy_v1.0";
  source.SchemaVersion = "2.1";
  return initializeEvent(source, source, "web");
}

async function finalizeImportSession(session) {
  if (session.status === "COMPLETE") return session;
  const missing = session.media.filter((item) => !item.uploaded);
  if (missing.length) throw requestError(409, `仍有 ${missing.length} 個檔案尚未上傳完成。`);
  const groups = groupImportedMedia(session.media);
  if (!groups.length) throw requestError(400, "沒有可建立的事件。");
  const importedEvents = groups.map((group, index) => importedEventFromGroup(session, group, index));
  const existingIds = new Set(events.map((event) => event.EventID));
  if (importedEvents.some((event) => existingIds.has(event.EventID))) throw requestError(409, "匯入事件編號與既有資料重複。");
  events.push(...importedEvents);
  try {
    for (const event of importedEvents) registerEventMedia(event);
    await persistEvents("web");
    session.status = "COMPLETE";
    session.completedAt = new Date().toISOString();
    session.eventIds = importedEvents.map((event) => event.EventID);
    await persistImportSession(session);
    return session;
  } catch (error) {
    events.splice(events.length - importedEvents.length, importedEvents.length);
    for (const item of session.media) mediaPaths.delete(item.mediaToken);
    throw error;
  }
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
  const resolved = mediaPaths.get(filename);
  if (!resolved) {
    textResponse(response, 404, "Unknown media");
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

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd || ROOT,
      windowsHide: true,
      shell: false,
      env: { ...process.env, PYTHONUTF8: "1", ...options.env },
    });
    let stdout = "";
    let stderr = "";
    const appendLimited = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"));
      options.onOutput?.(chunk.toString("utf8"), false);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"));
      options.onOutput?.(chunk.toString("utf8"), true);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function probeAiRuntime(force = false) {
  if (aiRuntimeStatus && !force) return aiRuntimeStatus;
  if (!existsSync(config.ai.pythonPath)) {
    aiRuntimeStatus = {
      ready: false,
      status: "NOT_INSTALLED",
      message: "尚未建立 AI Python 環境；請執行安裝AI辨識環境.cmd。",
      pythonPath: config.ai.pythonPath,
    };
    return aiRuntimeStatus;
  }
  try {
    const result = await runProcess(config.ai.pythonPath, [
      "-c",
      "import importlib.metadata as m,json; print(json.dumps({'megadetector':m.version('megadetector'),'speciesnet':m.version('speciesnet')}))",
    ]);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `exit ${result.code}`);
    const versions = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    aiRuntimeStatus = {
      ready: true,
      status: "READY",
      message: "MegaDetector 與 SpeciesNet 已可使用。",
      pythonPath: config.ai.pythonPath,
      detectorModel: config.ai.detectorModel,
      country: config.ai.country,
      versions,
    };
  } catch (error) {
    aiRuntimeStatus = {
      ready: false,
      status: "BROKEN",
      message: `AI 環境檢查失敗：${error.message}`,
      pythonPath: config.ai.pythonPath,
    };
  }
  return aiRuntimeStatus;
}

function publicAiJob(job) {
  return {
    jobId: job.jobId,
    eventId: job.eventId,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt || "",
    finishedAt: job.finishedAt || "",
    message: job.message || "",
    error: job.error || "",
    mode: job.mode || "full",
    identifySpecies: Boolean(job.identifySpecies),
    logTail: (job.log || "").slice(-4000),
  };
}

function normalizedLabelSet(value) {
  return String(value || "").split(";").map((label) => label.trim()).filter(Boolean).sort().join(";");
}

function detectionLabel(detection, categories) {
  const value = String(detection.label || categories?.[String(detection.category)] || detection.category || "").toLowerCase();
  if (value === "1" || value.includes("animal")) return "animal";
  if (value === "2" || value.includes("human") || value.includes("person")) return "person";
  if (value === "3" || value.includes("vehicle")) return "vehicle";
  return "";
}

function classificationEntry(entry, categories, descriptions = {}) {
  let id = "";
  let score = 0;
  if (Array.isArray(entry)) {
    id = String(entry[0] || "");
    score = Number(entry[1] || 0);
  } else if (entry && typeof entry === "object") {
    id = String(entry.category || entry.class || entry.class_id || entry.id || entry.label || "");
    score = Number(entry.conf ?? entry.score ?? entry.confidence ?? 0);
  } else {
    id = String(entry || "");
  }
  return {
    id,
    label: categories?.[id] || String(entry?.label || id),
    description: descriptions?.[id] || "",
    score,
  };
}

function normalizedTaxonText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function classificationSemanticLabel(entry) {
  const leaf = normalizedTaxonText(entry.description?.split(";").at(-1) || entry.label);
  if (["", "blank", "empty", "background"].includes(leaf)) return "empty";
  if (["person", "human"].includes(leaf)) return "person";
  if (leaf === "vehicle") return "vehicle";
  return "animal";
}

function localizedTaxonName(label, description = "") {
  const descriptionParts = String(description || "").split(";").map((part) => part.trim());
  const labelParts = String(label || "").split(";").map((part) => part.trim());
  const parts = descriptionParts.some(Boolean) ? descriptionParts : labelParts;
  const leaf = normalizedTaxonText(parts.at(-1) || label);
  if (["", "blank", "empty", "background", "person", "human", "vehicle"].includes(leaf)) return "";
  const genusSpecies = normalizedTaxonText([parts[4], parts[5]].filter(Boolean).join(" "));
  const normalizedParts = new Set([
    ...parts.map(normalizedTaxonText),
    genusSpecies,
    normalizedTaxonText(label),
  ].filter(Boolean));
  const match = taxonomy.find((taxon) => {
    const scientific = normalizedTaxonText(taxon.scientificName);
    const code = normalizedTaxonText(taxon.taxonCode);
    return (scientific && normalizedParts.has(scientific)) || (code && normalizedParts.has(code));
  });
  return CHINESE_TAXON_NAMES.get(leaf) || match?.commonName || `未知動物（${parts.at(-1) || label}，待人工確認）`;
}

function collectDetections(result) {
  const records = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (Array.isArray(value.detections)) records.push(...value.detections);
    for (const [key, child] of Object.entries(value)) {
      if (key !== "detections" && (Array.isArray(child) || (child && typeof child === "object"))) visit(child);
    }
  };
  visit(result.images || result.predictions || result.videos || []);
  return records;
}

function summarizeAiResult(result, presenceThreshold = 0.15) {
  const detectionCategories = result.detection_categories || { "1": "animal", "2": "person", "3": "vehicle" };
  const classificationCategories = result.classification_categories || {};
  const classificationDescriptions = result.classification_category_descriptions || {};
  const labels = new Set();
  const species = new Set();
  let confidence = 0;
  let speciesConfidence = 0;
  let animalDetections = 0;
  let classifiedAnimalDetections = 0;
  let blankAnimalDetections = 0;
  for (const detection of collectDetections(result)) {
    const detectionConfidence = Number(detection.conf ?? detection.score ?? 0);
    confidence = Math.max(confidence, detectionConfidence);
    if (detectionConfidence < presenceThreshold) continue;
    const label = detectionLabel(detection, detectionCategories);
    if (label !== "animal") {
      if (label) labels.add(label);
      continue;
    }
    animalDetections += 1;
    if (!Array.isArray(detection.classifications) || !detection.classifications.length) {
      labels.add("animal");
      continue;
    }
    classifiedAnimalDetections += 1;
    const top = classificationEntry(detection.classifications[0], classificationCategories, classificationDescriptions);
    const semanticLabel = classificationSemanticLabel(top);
    if (semanticLabel === "empty") {
      blankAnimalDetections += 1;
      continue;
    }
    if (semanticLabel === "person" || semanticLabel === "vehicle") {
      labels.add(semanticLabel);
      continue;
    }
    labels.add("animal");
    const name = localizedTaxonName(top.label, top.description);
    if (name) species.add(name);
    speciesConfidence = Math.max(speciesConfidence, top.score);
  }
  if (!labels.size) labels.add("empty");
  const failures = [];
  for (const image of result.images || result.predictions || []) {
    if (image.failure) failures.push(String(image.failure));
    if (Array.isArray(image.failures)) failures.push(...image.failures.map(String));
  }
  return {
    labels: [...labels].sort(),
    species: [...species].slice(0, 12),
    speciesConfidence: speciesConfidence ? speciesConfidence.toFixed(4) : "",
    confidence: confidence ? confidence.toFixed(4) : "0.0000",
    failures: [...new Set(failures)],
    reclassifiedFromAnimal: animalDetections > 0
      && classifiedAnimalDetections === animalDetections
      && blankAnimalDetections === animalDetections,
  };
}

function applyAiSummaryToEvent(event, summary, { identifySpecies = false, mode = "fast" } = {}) {
  event.AIStatus = "AI_COMPLETE";
  event.AIEventLabels = summary.labels.length ? summary.labels.join(";") : "empty";
  event.AISpecies = identifySpecies ? summary.species.join(";") : "";
  event.AISpeciesConfidence = identifySpecies ? summary.speciesConfidence : "";
  event.AIConfidence = summary.confidence;
  event.AIModelName = identifySpecies ? "MegaDetector + SpeciesNet" : "MegaDetector 空觸發初篩";
  event.AIModelVersion = [
    `MegaDetector ${config.ai.megadetectorVersion} (${config.ai.detectorModel})`,
    identifySpecies ? `SpeciesNet ${config.ai.speciesnetVersion}` : "SpeciesNet skipped",
    `mode=${mode}`,
    `species=${identifySpecies ? "yes" : "no"}`,
    identifySpecies ? SPECIES_RESULT_VERSION : "",
    AI_TRIAGE_VERSION,
  ].filter(Boolean).join("; ");
  event.AIProcessedAt = new Date().toISOString();
  event.AIError = summary.failures.join("; ");
  if (event.HumanLabels && normalizedLabelSet(event.HumanLabels) !== normalizedLabelSet(event.AIEventLabels)) {
    event.ReviewStatus = "CONFLICT";
  } else if (event.HumanLabels && event.ReviewStatus === "CONFLICT") {
    event.ReviewStatus = "HUMAN_CONFIRMED";
  } else if (!event.HumanLabels && !event.ReviewStatus) {
    event.ReviewStatus = "NEEDS_REVIEW";
  }
  event.SchemaVersion = "2.1";
}

async function reclassifyCachedSpeciesResults(candidates, mode = "fast") {
  let directories = [];
  try {
    directories = (await readdir(config.ai.jobsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return 0;
  }
  let updated = 0;
  for (const event of candidates) {
    const modelVersion = String(event.AIModelVersion || "");
    if (!modelVersion.includes("species=yes") || !modelVersion.includes(`mode=${mode}`)) continue;
    const prefix = `AI-${event.EventID}-`;
    const matchingDirectories = directories.filter((name) => name.startsWith(prefix));
    for (const directory of matchingDirectories) {
      try {
        const resultPath = path.join(config.ai.jobsRoot, directory, "result.json");
        const rawResult = JSON.parse(await readFile(resultPath, "utf8"));
        const summary = summarizeAiResult(rawResult, config.ai.detectionThresholdForClassification);
        applyAiSummaryToEvent(event, summary, { identifySpecies: true, mode });
        updated += 1;
        break;
      } catch {
        // Try the next older cached result; a partial job may not contain valid JSON.
      }
    }
  }
  if (updated) await persistEvents("web");
  return updated;
}

function normalizeAiMode(value, fallback = "full") {
  return value === "fast" || value === "full" ? value : fallback;
}

function normalizeIdentifySpecies(value, fallback = false) {
  if ([true, 1, "1", "true", "yes"].includes(value)) return true;
  if ([false, 0, "0", "false", "no"].includes(value)) return false;
  return fallback;
}

function setAiQueuePaused(paused) {
  aiQueuePaused = Boolean(paused);
  if (!aiQueuePaused) {
    const waiters = aiResumeWaiters;
    aiResumeWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

async function waitForAiQueueResume() {
  if (!aiQueuePaused) return;
  await new Promise((resolve) => aiResumeWaiters.push(resolve));
}

async function stageEventMedia(event, inputRoot, mode = "full", identifySpecies = false) {
  await mkdir(inputRoot, { recursive: true });
  const fields = mode === "fast"
    ? ["Photo1", "Photo3"]
    : (identifySpecies ? ["Photo1", "Photo2", "Photo3", "Video"] : ["Photo1", "Photo2", "Photo3"]);
  for (const field of fields) {
    const filename = event[field];
    if (!filename) continue;
    const source = mediaPaths.get(filename);
    if (!source) throw new Error(`拒絕未知媒體：${filename}`);
    const target = path.resolve(inputRoot, `${field}-${path.basename(filename)}`);
    try {
      await link(source, target);
    } catch (linkError) {
      try {
        await symlink(source, target, "file");
      } catch {
        try {
          await copyFile(source, target);
        } catch (copyError) {
          throw new Error(`無法準備 AI 媒體：${filename}（${copyError.message || linkError.message}）`);
        }
      }
    }
  }
}

async function runAiJob(job, event) {
  if (job.cancelRequested) {
    job.status = "CANCELLED";
    job.finishedAt = new Date().toISOString();
    job.message = "工作已取消。";
    return;
  }
  job.status = "AI_RUNNING";
  job.startedAt = new Date().toISOString();
  job.message = "正在準備事件媒體…";
  event.AIStatus = "AI_RUNNING";
  event.AIError = "";
  saveQueue = saveQueue.then(() => persistEvent(event), () => persistEvent(event));
  await saveQueue;
  try {
    const jobsRoot = path.resolve(config.ai.jobsRoot);
    const jobRoot = path.resolve(jobsRoot, job.jobId);
    if (!jobRoot.startsWith(`${jobsRoot}${path.sep}`)) throw new Error("AI 工作路徑超出允許範圍。");
    const inputRoot = path.join(jobRoot, "input");
    const resultFile = path.join(jobRoot, "result.json");
    const kaggleCacheRoot = path.join(config.ai.modelCacheRoot, "kagglehub");
    await mkdir(kaggleCacheRoot, { recursive: true });
    const identifySpecies = Boolean(job.identifySpecies);
    await stageEventMedia(event, inputRoot, job.mode, identifySpecies);
    const fastMode = job.mode === "fast";
    job.message = identifySpecies
      ? (fastMode
        ? "快速模式：判斷空觸發，動物事件繼續辨識物種…"
        : "完整模式：判斷空觸發，動物事件繼續辨識物種與影片…")
      : (fastMode
        ? "快速初篩中：只判斷第 1、3 張照片是否為空觸發…"
        : "完整初篩中：以三張照片判斷是否為空觸發…");
    const args = !identifySpecies
      ? [
        "-m", "megadetector.detection.run_detector_batch",
        config.ai.detectorModel, inputRoot, resultFile,
        "--recursive", "--output_relative_filenames", "--include_max_conf",
        "--threshold", String(config.ai.detectionThresholdForClassification),
        "--ncores", "2",
      ]
      : [
        "-m", "megadetector.detection.run_md_and_speciesnet",
        inputRoot, resultFile,
        "--detector_model", config.ai.detectorModel,
        "--detection_confidence_threshold_for_classification", String(config.ai.detectionThresholdForClassification),
        "--detection_confidence_threshold_for_output", String(config.ai.detectionThresholdForOutput),
        "--time_sample", String(config.ai.timeSampleSeconds),
        "--include_raw_classifications",
      ];
    if (identifySpecies && config.ai.country) args.push("--country", config.ai.country);
    const processResult = await runProcess(config.ai.pythonPath, args, {
      env: { KAGGLEHUB_CACHE: kaggleCacheRoot },
      onOutput: (chunk) => { job.log = `${job.log || ""}${chunk}`.slice(-100_000); },
    });
    await writeFile(path.join(jobRoot, "inference.log"), `${processResult.stdout}\n${processResult.stderr}`, "utf8");
    if (job.cancelRequested) {
      job.status = "CANCELLED";
      job.message = "工作已取消；辨識結果未寫入。";
      return;
    }
    if (processResult.code !== 0) throw new Error(processResult.stderr.slice(-2000) || `AI 程序結束碼 ${processResult.code}`);
    const rawResult = JSON.parse(await readFile(resultFile, "utf8"));
    const summary = summarizeAiResult(rawResult, config.ai.detectionThresholdForClassification);
    applyAiSummaryToEvent(event, summary, { identifySpecies, mode: job.mode });
    job.status = "AI_COMPLETE";
    const triage = event.AIEventLabels.includes("animal")
      ? (identifySpecies
        ? (event.AISpecies ? `物種候選：${event.AISpecies}` : "偵測到動物；物種無法辨識")
        : "偵測到動物；未要求物種辨識")
      : (event.AIEventLabels === "empty"
        ? (summary.reclassifiedFromAnimal ? "SpeciesNet 未確認動物，改列空觸發" : "空觸發")
        : "非空觸發（人／車）");
    job.message = `完成：${triage}`;
  } catch (error) {
    if (job.cancelRequested) {
      job.status = "CANCELLED";
      job.message = "工作已取消；辨識結果未寫入。";
    } else {
      event.AIStatus = "FAILED";
      event.AIError = error.message.slice(0, 4000);
      event.AIProcessedAt = new Date().toISOString();
      job.status = "FAILED";
      job.error = event.AIError;
      job.message = "AI 推論失敗；人工答案未被修改。";
    }
  } finally {
    job.finishedAt = new Date().toISOString();
    event.SchemaVersion = "2.1";
    saveQueue = saveQueue.then(() => persistEvent(event), () => persistEvent(event));
    await saveQueue;
  }
}

async function createAiJob(event, options = {}) {
  const active = [...aiJobs.values()].find((job) => job.eventId === event.EventID && ["AI_PENDING", "AI_RUNNING"].includes(job.status));
  if (active) return { job: active, created: false };
  const mode = normalizeAiMode(options.mode, "full");
  const identifySpecies = normalizeIdentifySpecies(options.identifySpecies, false);
  const job = {
    jobId: `AI-${event.EventID}-${Date.now()}`.replace(/[^A-Za-z0-9_.-]/g, "-"),
    eventId: event.EventID,
    status: "AI_PENDING",
    createdAt: new Date().toISOString(),
    mode,
    identifySpecies,
    message: identifySpecies
      ? `${mode === "fast" ? "快速" : "完整"}辨識已排入佇列；有動物才會執行 SpeciesNet。`
      : `${mode === "fast" ? "快速" : "完整"}空觸發初篩已排入佇列。`,
    log: "",
  };
  aiJobs.set(job.jobId, job);
  setImmediate(() => {
    aiRunQueue = aiRunQueue
      .then(async () => {
        await waitForAiQueueResume();
        return runAiJob(job, event);
      }, async () => {
        await waitForAiQueueResume();
        return runAiJob(job, event);
      })
      .catch((error) => console.error("AI job failed", error));
  });
  return { job, created: true };
}

function hasCurrentAiTriage(event) {
  return event.AIStatus === "AI_COMPLETE" && String(event.AIModelVersion || "").includes(AI_TRIAGE_VERSION);
}

function isCompleteForAiPreference(event, identifySpecies = false, mode = "fast") {
  if (!hasCurrentAiTriage(event)) return false;
  if (mode === "full" && !String(event.AIModelVersion || "").includes("mode=full")) return false;
  if (!identifySpecies) return true;
  const labels = String(event.AIEventLabels || "").split(";");
  if (!labels.includes("animal")) return true;
  const modelVersion = String(event.AIModelVersion || "");
  return modelVersion.includes("species=yes")
    && modelVersion.includes(SPECIES_RESULT_VERSION)
    && Boolean(String(event.AISpecies || "").trim());
}

function aiBatchStatus(identifySpecies = aiBatchPreference.identifySpecies, mode = aiBatchPreference.mode) {
  const workspace = webWorkspaceEvents();
  const workspaceIds = new Set(workspace.map((event) => event.EventID));
  const jobs = [...aiJobs.values()];
  const activeJobs = jobs.filter((job) => workspaceIds.has(job.eventId) && ["AI_PENDING", "AI_RUNNING"].includes(job.status));
  const runningJob = activeJobs.find((job) => job.status === "AI_RUNNING");
  const complete = workspace.filter((event) => isCompleteForAiPreference(event, identifySpecies, mode)).length;
  const failed = workspace.filter((event) => event.AIStatus === "FAILED").length;
  const emptyTrigger = workspace.filter((event) => hasCurrentAiTriage(event) && event.AIEventLabels === "empty").length;
  const needsSpecies = workspace.filter((event) => hasCurrentAiTriage(event) && String(event.AIEventLabels).split(";").includes("animal")).length;
  const speciesPending = workspace.filter((event) => {
    const labels = String(event.AIEventLabels || "").split(";");
    return labels.includes("animal") && !isCompleteForAiPreference(event, true, mode);
  }).length;
  return {
    total: workspace.length,
    complete,
    failed,
    emptyTrigger,
    needsSpecies,
    speciesPending,
    remaining: workspace.length - complete,
    queued: activeJobs.filter((job) => job.status === "AI_PENDING").length,
    running: activeJobs.filter((job) => job.status === "AI_RUNNING").length,
    active: activeJobs.length > 0,
    paused: aiQueuePaused,
    currentEventId: runningJob?.eventId || "",
    identifySpecies: Boolean(identifySpecies),
    mode: normalizeAiMode(mode, "fast"),
  };
}

async function createAiBatch(mode = "fast", identifySpecies = false) {
  const normalizedMode = normalizeAiMode(mode, "fast");
  const normalizedSpecies = normalizeIdentifySpecies(identifySpecies, false);
  aiBatchPreference = { mode: normalizedMode, identifySpecies: normalizedSpecies };
  const workspace = webWorkspaceEvents();
  let candidates = workspace.filter((event) => !isCompleteForAiPreference(event, normalizedSpecies, normalizedMode));
  const reclassified = normalizedSpecies
    ? await reclassifyCachedSpeciesResults(candidates, normalizedMode)
    : 0;
  candidates = workspace.filter((event) => !isCompleteForAiPreference(event, normalizedSpecies, normalizedMode));
  let created = 0;
  let alreadyQueued = 0;
  for (const event of candidates) {
    const result = await createAiJob(event, { mode: normalizedMode, identifySpecies: normalizedSpecies });
    if (result.created) created += 1;
    else alreadyQueued += 1;
  }
  return {
    created,
    alreadyQueued,
    mode: normalizedMode,
    identifySpecies: normalizedSpecies,
    reclassified,
    skippedCompleted: workspace.length - candidates.length,
    status: aiBatchStatus(normalizedSpecies, normalizedMode),
  };
}

function cancelWorkspaceAiJobs() {
  const workspaceIds = new Set(webWorkspaceEvents().map((event) => event.EventID));
  let cancelled = 0;
  for (const job of aiJobs.values()) {
    if (!workspaceIds.has(job.eventId) || !["AI_PENDING", "AI_RUNNING"].includes(job.status)) continue;
    job.cancelRequested = true;
    job.status = "CANCELLED";
    job.finishedAt = new Date().toISOString();
    job.message = "工作已由使用者取消。";
    cancelled += 1;
  }
  setAiQueuePaused(false);
  return cancelled;
}

async function resetAiWorkspace() {
  const workspace = webWorkspaceEvents();
  const cancelled = cancelWorkspaceAiJobs();
  const aiDrivenReviewStatuses = new Set(["AI_PENDING", "AI_RUNNING", "AI_COMPLETE", "NEEDS_REVIEW", "CONFLICT", "FAILED"]);
  for (const event of workspace) {
    for (const field of AI_FIELDS) event[field] = "";
    event.AIStatus = "AI_PENDING";
    if (!event.HumanLabels && aiDrivenReviewStatuses.has(event.ReviewStatus)) event.ReviewStatus = "";
  }
  await persistEvents("web");
  return { reset: workspace.length, cancelled, status: aiBatchStatus(aiBatchPreference.identifySpecies, aiBatchPreference.mode) };
}

async function clearWebWorkspace() {
  const removed = webWorkspaceEvents().length;
  const cancelled = cancelWorkspaceAiJobs();
  events = events.filter((event) => !isWebWorkspaceEvent(event));
  importSessions.clear();
  mediaPaths.clear();
  for (const event of events) registerEventMedia(event);
  await rm(config.webUploads.mediaRoot, { recursive: true, force: true });
  await rm(config.webUploads.sessionsRoot, { recursive: true, force: true });
  await unlink(config.webUploads.eventsCsv).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await mkdir(config.webUploads.mediaRoot, { recursive: true });
  await mkdir(config.webUploads.sessionsRoot, { recursive: true });
  await persistEvents("web");
  return { removed, cancelled, status: aiBatchStatus(aiBatchPreference.identifySpecies, aiBatchPreference.mode) };
}

function statusSummary() {
  const reviewedStatuses = new Set(["HUMAN_CONFIRMED", "UNCERTAIN", "CONFLICT", "double_checked", "adjudicated"]);
  const reviewed = events.filter((event) => reviewedStatuses.has(event.ReviewStatus)
    || (event.ReviewStatus === "first_pass" && event.FinalDecision)).length;
  return {
    total: events.length,
    reviewed,
    unreviewed: events.length - reviewed,
    firstPass: events.filter((event) => event.ReviewStatus === "first_pass").length,
    doubleChecked: events.filter((event) => event.ReviewStatus === "double_checked").length,
    adjudicated: events.filter((event) => event.ReviewStatus === "adjudicated").length,
    aiPending: events.filter((event) => ["AI_PENDING", "AI_RUNNING"].includes(event.AIStatus)).length,
    aiComplete: events.filter((event) => event.AIStatus === "AI_COMPLETE").length,
    needsReview: events.filter((event) => event.ReviewStatus === "NEEDS_REVIEW").length,
    humanConfirmed: events.filter((event) => event.ReviewStatus === "HUMAN_CONFIRMED").length,
    uncertain: events.filter((event) => event.ReviewStatus === "UNCERTAIN").length,
    conflict: events.filter((event) => event.ReviewStatus === "CONFLICT").length,
    failed: events.filter((event) => event.ReviewStatus === "FAILED" || event.AIStatus === "FAILED").length,
  };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  try {
    const corsAllowed = applyCorsHeaders(request, response);
    if (request.headers.origin && !corsAllowed) {
      jsonResponse(response, 403, { ok: false, error: "不允許的網站來源。" });
    } else if (request.method === "OPTIONS") {
      response.writeHead(corsAllowed ? 204 : 403, { "Content-Length": "0" });
      response.end();
    } else if (request.method === "GET" && url.pathname === "/api/health") {
      jsonResponse(response, 200, {
        ok: true,
        deploymentId: config.deploymentId,
        events: events.length,
        registeredEvents: events.filter((event) => !isWebWorkspaceEvent(event)).length,
        webEvents: webWorkspaceEvents().length,
        storageMode: config.storageMode,
      });
    } else if (request.method === "GET" && url.pathname === "/api/config") {
      const runtime = await probeAiRuntime();
      jsonResponse(response, 200, {
        appName: config.appName,
        deploymentId: config.deploymentId,
        sourceManifest: config.manifestCsv,
        workingCsv: config.workingCsv,
        auditLog: config.auditLog,
        storageMode: config.storageMode,
        storageNotice: config.storageNotice,
        mediaRoot: config.mediaRoot,
        photoFirstWorkflow: true,
        schemaVersion: "2.1",
        webUpload: {
          enabled: true,
          storageMode: config.webUploads.storageMode,
          storageNotice: config.webUploads.storageNotice,
          maxFilesPerImport: config.webUploads.maxFilesPerImport,
          maxFileBytes: config.webUploads.maxFileBytes,
          eventGapSeconds: config.webUploads.eventGapSeconds,
          acceptedExtensions: [...UPLOAD_EXTENSIONS],
        },
        inferenceAvailable: runtime.ready,
        aiRuntime: runtime,
        aiJobsRoot: config.ai.jobsRoot,
        aiJobsStorageMode: config.ai.jobsStorageMode,
      });
    } else if (request.method === "GET" && url.pathname === "/api/ai/status") {
      jsonResponse(response, 200, {
        runtime: await probeAiRuntime(url.searchParams.get("refresh") === "1"),
        activeJobs: [...aiJobs.values()].filter((job) => ["AI_PENDING", "AI_RUNNING"].includes(job.status)).map(publicAiJob),
      });
    } else if (request.method === "GET" && url.pathname === "/api/ai/batch") {
      const identifySpecies = normalizeIdentifySpecies(url.searchParams.get("identifySpecies"), aiBatchPreference.identifySpecies);
      const mode = normalizeAiMode(url.searchParams.get("mode"), aiBatchPreference.mode);
      jsonResponse(response, 200, { ok: true, status: aiBatchStatus(identifySpecies, mode) });
    } else if (request.method === "GET" && url.pathname.startsWith("/api/ai/jobs/")) {
      const jobId = decodeURIComponent(url.pathname.slice("/api/ai/jobs/".length));
      const job = aiJobs.get(jobId);
      if (!job) jsonResponse(response, 404, { ok: false, error: "找不到 AI 工作。" });
      else jsonResponse(response, 200, { ok: true, job: publicAiJob(job) });
    } else if (request.method === "GET" && url.pathname === "/api/events") {
      jsonResponse(response, 200, { events: events.map(publicEvent), status: statusSummary() });
    } else if (request.method === "GET" && url.pathname === "/api/taxonomy") {
      jsonResponse(response, 200, { taxonomy });
    } else if (request.method === "GET" && url.pathname === "/api/status") {
      jsonResponse(response, 200, statusSummary());
    } else if (request.method === "POST" && url.pathname === "/api/imports") {
      const body = await readRequestBody(request, 10_000_000);
      const session = await createImportSession(body);
      jsonResponse(response, 201, { ok: true, import: publicImportSession(session) });
    } else if (request.method === "GET" && /^\/api\/imports\/[^/]+$/.test(url.pathname)) {
      const importId = decodeURIComponent(url.pathname.slice("/api/imports/".length));
      const session = await getImportSession(importId);
      if (!session) jsonResponse(response, 404, { ok: false, error: "找不到匯入工作。" });
      else jsonResponse(response, 200, { ok: true, import: publicImportSession(session) });
    } else if (request.method === "DELETE" && /^\/api\/imports\/[^/]+$/.test(url.pathname)) {
      const importId = decodeURIComponent(url.pathname.slice("/api/imports/".length));
      const session = await getImportSession(importId);
      if (!session) throw requestError(404, "找不到匯入工作。");
      await cancelImportSession(session);
      jsonResponse(response, 200, { ok: true, cancelled: importId });
    } else if (request.method === "POST" && /^\/api\/imports\/[^/]+\/files\/\d+$/.test(url.pathname)) {
      const match = /^\/api\/imports\/([^/]+)\/files\/(\d+)$/.exec(url.pathname);
      const importId = decodeURIComponent(match[1]);
      const session = await getImportSession(importId);
      if (!session) throw requestError(404, "找不到匯入工作。");
      const item = await receiveImportFile(request, session, Number(match[2]));
      jsonResponse(response, 200, {
        ok: true,
        import: publicImportSession(session),
        file: { index: item.index, filename: item.filename, sha256: item.serverSha256 },
      });
    } else if (request.method === "POST" && /^\/api\/imports\/[^/]+\/finalize$/.test(url.pathname)) {
      const importId = decodeURIComponent(url.pathname.slice("/api/imports/".length, -"/finalize".length));
      const session = await getImportSession(importId);
      if (!session) throw requestError(404, "找不到匯入工作。");
      await finalizeImportSession(session);
      jsonResponse(response, 201, { ok: true, import: publicImportSession(session), status: statusSummary() });
    } else if (request.method === "GET" && url.pathname === "/api/export.csv") {
      const csv = stringifyCsv(events, ALL_FIELDS);
      response.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"camera_trap_events.csv\"",
        "Content-Length": Buffer.byteLength(csv),
        "Cache-Control": "no-store",
      });
      response.end(csv);
    } else if (request.method === "POST" && url.pathname === "/api/ai/jobs") {
      const runtime = await probeAiRuntime(true);
      if (!runtime.ready) {
        jsonResponse(response, 503, { ok: false, error: runtime.message, runtime });
        return;
      }
      const body = await readRequestBody(request);
      const event = events.find((candidate) => candidate.EventID === body.EventID);
      if (!event) {
        jsonResponse(response, 400, { ok: false, error: "EventID 不存在。" });
        return;
      }
      const { job, created } = await createAiJob(event, {
        mode: normalizeAiMode(body.mode, "full"),
        identifySpecies: normalizeIdentifySpecies(body.identifySpecies, false),
      });
      jsonResponse(response, created ? 202 : 200, { ok: true, created, job: publicAiJob(job) });
    } else if (request.method === "POST" && url.pathname === "/api/ai/batch") {
      const runtime = await probeAiRuntime(true);
      if (!runtime.ready) {
        jsonResponse(response, 503, { ok: false, error: runtime.message, runtime });
        return;
      }
      const body = await readRequestBody(request);
      const batch = await createAiBatch(
        normalizeAiMode(body.mode, "fast"),
        normalizeIdentifySpecies(body.identifySpecies, false),
      );
      jsonResponse(response, batch.created ? 202 : 200, { ok: true, ...batch });
    } else if (request.method === "POST" && url.pathname === "/api/ai/batch/pause") {
      const body = await readRequestBody(request);
      setAiQueuePaused(Boolean(body.paused));
      jsonResponse(response, 200, { ok: true, status: aiBatchStatus(aiBatchPreference.identifySpecies, aiBatchPreference.mode) });
    } else if (request.method === "POST" && url.pathname === "/api/ai/reset") {
      const body = await readRequestBody(request);
      if (body.confirm !== "RESET_AI_WORKSPACE") throw requestError(400, "缺少 AI 重置確認。");
      const result = await resetAiWorkspace();
      jsonResponse(response, 200, { ok: true, ...result });
    } else if (request.method === "POST" && url.pathname === "/api/workspace/clear") {
      const body = await readRequestBody(request);
      if (body.confirm !== "CLEAR_UPLOAD_WORKSPACE") throw requestError(400, "缺少清除工作區確認。");
      const result = await clearWebWorkspace();
      jsonResponse(response, 200, { ok: true, ...result });
    } else if (request.method === "POST" && url.pathname === "/api/annotations") {
      const body = await readRequestBody(request);
      const errors = validatePatch(body);
      if (errors.length) {
        jsonResponse(response, 400, { ok: false, errors });
        return;
      }
      const event = events.find((candidate) => candidate.EventID === body.EventID);
      const before = { ...event };
      for (const field of EDITABLE_FIELDS) {
        if (field in body) event[field] = String(body[field] ?? "");
      }
      event.SchemaVersion = "2.1";
      event.LastModifiedAt = new Date().toISOString();
      event.LastModifiedBy = event.Annotator || event.SecondReviewer || event.Adjudicator || "UNKNOWN";
      if (["HUMAN_CONFIRMED", "UNCERTAIN", "CONFLICT", "double_checked", "adjudicated"].includes(event.ReviewStatus)) {
        event.ReviewedAt = event.LastModifiedAt;
      }
      saveQueue = saveQueue.then(() => persistEvent(event), () => persistEvent(event));
      await saveQueue;
      await appendAuditEntry(before, event);
      jsonResponse(response, 200, { ok: true, event: publicEvent(event), status: statusSummary() });
    } else if (request.method === "GET" && url.pathname.startsWith("/media/")) {
      await serveMedia(request, response, url.pathname.slice("/media/".length));
    } else if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(request, response, url.pathname);
    } else {
      textResponse(response, 405, "Method not allowed");
    }
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    if (statusCode >= 500) console.error(error);
    jsonResponse(response, statusCode, statusCode >= 500
      ? { ok: false, error: "伺服器處理失敗。", detail: error.message }
      : { ok: false, error: error.message });
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
