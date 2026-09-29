import { stringifyCsv } from "./csv.mjs";
import { MAX_PHOTOS_PER_EVENT, photoEntries } from "../public/media-options.js";

const DECISION_NAMES = new Map([
  ["empty", "空觸發"], ["animal", "動物"], ["person", "人"], ["vehicle", "車輛"],
  ["equipment_error", "設備異常"], ["uncertain", "不確定"], ["mixed", "混合事件"],
]);
const STATUS_NAMES = new Map([
  ["AI_PENDING", "待辨識"], ["AI_RUNNING", "辨識中"], ["AI_COMPLETE", "辨識完成"],
  ["NEEDS_REVIEW", "需要人工覆核"], ["HUMAN_CONFIRMED", "人工確認完成"],
  ["UNCERTAIN", "資訊不足／不確定"], ["CONFLICT", "結果衝突"], ["FAILED", "處理失敗"],
  ["first_pass", "初判完成"], ["double_checked", "雙人複核完成"], ["adjudicated", "裁決完成"],
]);

function decisionText(value) {
  return String(value || "").split(";").map((label) => label.trim()).filter(Boolean)
    .map((label) => DECISION_NAMES.get(label) ?? label).join("、");
}

function statusText(value, fallback) {
  return STATUS_NAMES.get(value) ?? (value || fallback);
}

// This is a presentation-only schema. The internal working CSV keeps all of its
// original English fields so saving reviews and restarting remain lossless.
const SUMMARY_COLUMNS = [
  ["批次編號", (event) => event.DeploymentID],
  ["事件編號", (event) => event.EventID],
  ["事件時間", (event) => event.EventTime],
  ["辨識狀態", (event) => statusText(event.AIStatus, "待辨識")],
  ["自動判定", (event) => [decisionText(event.AIEventLabels),
    event.AIRepeatDetection === "yes" ? "疑似固定背景誤判（待確認）" : ""].filter(Boolean).join("；")],
  ["物種候選", (event) => event.AISpecies],
  ["覆核狀態", (event) => statusText(event.ReviewStatus, "尚未覆核")],
  ["人工判定", (event) => decisionText(event.HumanLabels || event.FinalDecision)],
  ["人工物種", (event) => [event.CommonName || event.ScientificName || event.TaxonCode,
    event.AdditionalTaxonCodes].filter(Boolean).join("；")],
  ["個體數", (event) => event.IndividualCountMax !== "" && event.IndividualCountMax != null
    ? event.IndividualCountMax : event.CountMin],
  ["覆核人員", (event) => event.Annotator],
  ["覆核時間", (event) => event.ReviewedAt],
  ["修正原因", (event) => event.CorrectionReason],
  ["備註", (event) => event.Notes],
];

export function exportEventsCsv(events) {
  let photoCount = 0;
  let hasVideo = false;
  const media = events.map((event) => {
    const configuredCount = Number(event.PhotosPerEvent);
    if (Number.isInteger(configuredCount) && configuredCount >= 1 && configuredCount <= MAX_PHOTOS_PER_EVENT) {
      photoCount = Math.max(photoCount, configuredCount);
    }
    const photos = photoEntries(event);
    for (const { field } of photos) photoCount = Math.max(photoCount, Number(field.slice(5)));
    if (event.Video) hasVideo = true;
    return Object.fromEntries(photos.map(({ field, token }) => [field, token]));
  });
  const photoHeaders = Array.from({ length: photoCount }, (_, index) => `照片${index + 1}`);
  const headers = [...SUMMARY_COLUMNS.map(([header]) => header), ...photoHeaders, ...(hasVideo ? ["影片"] : [])];
  const rows = events.map((event, index) => {
    const row = Object.fromEntries(SUMMARY_COLUMNS.map(([header, value]) => [header, value(event) ?? ""]));
    for (let slot = 1; slot <= photoCount; slot++) row[`照片${slot}`] = media[index][`Photo${slot}`] || "";
    if (hasVideo) row["影片"] = event.Video || "";
    return row;
  });
  return stringifyCsv(rows, headers);
}

function exportError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function selectExportEvents(events, parameters) {
  if (!parameters.has("deploymentId")) return { events, deploymentId: null };
  const ids = parameters.getAll("deploymentId");
  if (ids.length !== 1 || !ids[0].trim()) throw exportError(400, "請選擇一個有效的匯出批次。");
  const deploymentId = ids[0];
  const selected = events.filter((event) => event.DeploymentID === deploymentId);
  if (!selected.length) throw exportError(404, "此批次不存在或已被清除，請重新開啟匯出視窗選擇批次。");
  return { events: selected, deploymentId };
}

export function exportDisposition(deploymentId, date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
  const batch = deploymentId === null ? "all-batches" : String(deploymentId)
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").slice(0, 100).replace(/[. ]+$/, "") || "batch";
  const filename = `camera_trap_${batch}_${timestamp}.csv`;
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="camera_trap_events_${timestamp}.csv"; filename*=UTF-8''${encoded}`;
}
