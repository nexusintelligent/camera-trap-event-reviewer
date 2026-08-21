import assert from "node:assert/strict";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:4173";
const allowWrite = process.env.SMOKE_ALLOW_WRITE === "1";
const allowImport = process.env.SMOKE_ALLOW_IMPORT === "1";

async function json(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json();
  return { response, body };
}

const checks = [];

const pageResponse = await fetch(`${baseUrl}/`);
const pageHtml = await pageResponse.text();
assert.equal(pageResponse.status, 200);
assert.match(pageHtml, /rel="manifest" href="\.\/manifest\.webmanifest"/);
assert.match(pageHtml, /name="theme-color"/);
assert.match(pageHtml, /id="import-dialog"/);
assert.match(pageHtml, /id="human-label-options"/);
assert.match(pageHtml, /id="ai-section"/);
assert.match(pageHtml, /id="start-ai-button"/);
assert.match(pageHtml, /id="start-ai-batch-button"/);
assert.match(pageHtml, /id="pause-ai-batch-button"/);
assert.match(pageHtml, /id="reset-ai-workspace-button"/);
assert.match(pageHtml, /id="clear-upload-workspace-button"/);
assert.match(pageHtml, /id="identify-species-toggle"/);
assert.match(pageHtml, /id="clear-import-button"/);
assert.match(pageHtml, /id="upload-view"/);
assert.match(pageHtml, /id="review-view"/);
assert.match(pageHtml, /id="import-deployment-name"/);
assert.match(pageHtml, /id="upload-result-list"/);
assert.match(pageHtml, /id="upload-results-batch-select"/);
assert.match(pageHtml, /id="ai-result-dialog"/);
assert.match(pageHtml, /id="review-collection-select"/);
assert.match(pageHtml, /<option value="ai_complete">AI 已辨識<\/option>/);
assert.match(pageHtml, /id="review-tab"[^>]*>人工覆核<\/button>/);
assert.match(pageHtml, /上傳並建立事件/);
checks.push("pwa:batch-results-and-review-controls");

const appResponse = await fetch(`${baseUrl}/app.js`);
const appSource = await appResponse.text();
assert.equal(appResponse.status, 200);
assert.match(appSource, /function webBatchEntries\(\)/);
assert.match(appSource, /function renderUploadResults\(\)/);
assert.match(appSource, /filter === "ai_complete"/);
checks.push("ui:batch-separated-result-and-review-logic");

const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
assert.equal(manifestResponse.status, 200);
assert.match(manifestResponse.headers.get("content-type") || "", /application\/manifest\+json/);
const manifest = await manifestResponse.json();
assert.equal(manifest.display, "standalone");
assert.equal(manifest.start_url, "./");
assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
checks.push("pwa:manifest-installable");

const serviceWorkerResponse = await fetch(`${baseUrl}/service-worker.js`);
const serviceWorker = await serviceWorkerResponse.text();
assert.equal(serviceWorkerResponse.status, 200);
assert.match(serviceWorkerResponse.headers.get("content-type") || "", /javascript/);
assert.match(serviceWorker, /caches\.open/);
assert.match(serviceWorker, /\/api\//);
checks.push("pwa:service-worker-shell-only");

const iconResponse = await fetch(`${baseUrl}/icons/icon-192.png`);
assert.equal(iconResponse.status, 200);
assert.match(iconResponse.headers.get("content-type") || "", /image\/png/);
const iconMagic = new Uint8Array(await iconResponse.arrayBuffer());
assert.deepEqual([...iconMagic.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
checks.push("pwa:icons");

const pagesOrigin = "https://nexusintelligent.github.io";
const corsPreflight = await fetch(`${baseUrl}/api/events`, {
  method: "OPTIONS",
  headers: {
    Origin: pagesOrigin,
    "Access-Control-Request-Method": "GET",
    "Access-Control-Request-Private-Network": "true",
  },
});
assert.equal(corsPreflight.status, 204);
assert.equal(corsPreflight.headers.get("access-control-allow-origin"), pagesOrigin);
assert.equal(corsPreflight.headers.get("access-control-allow-private-network"), "true");
checks.push("pages:local-service-cors");

const rejectedOrigin = await fetch(`${baseUrl}/api/annotations`, {
  method: "POST",
  headers: { Origin: "https://malicious.example", "Content-Type": "application/json" },
  body: JSON.stringify({ EventID: "not-used" }),
});
assert.equal(rejectedOrigin.status, 403);
checks.push("security:origin-rejected");

const health = await json("/api/health");
assert.equal(health.response.status, 200);
assert.equal(health.body.ok, true);
assert.equal(health.body.registeredEvents, 154);
assert.equal(health.body.events, health.body.registeredEvents + health.body.webEvents);
checks.push("health:review-and-upload-sources-separated");

const configPayload = await json("/api/config");
assert.equal(configPayload.response.status, 200);
assert.equal(configPayload.body.schemaVersion, "2.1");
assert.equal(typeof configPayload.body.inferenceAvailable, "boolean");
assert.equal(typeof configPayload.body.aiRuntime?.status, "string");
assert.ok(configPayload.body.auditLog);
assert.equal(configPayload.body.webUpload?.enabled, true);
assert.ok(configPayload.body.webUpload?.acceptedExtensions.includes(".jpg"));
checks.push("config:v2-capabilities");

const invalidImport = await json("/api/imports", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ deploymentName: "invalid", media: [] }),
});
assert.equal(invalidImport.response.status, 400);
checks.push("upload:invalid-manifest-rejected");

const aiStatus = await json("/api/ai/status");
assert.equal(aiStatus.response.status, 200);
assert.equal(typeof aiStatus.body.runtime?.ready, "boolean");
assert.ok(["READY", "NOT_INSTALLED", "BROKEN"].includes(aiStatus.body.runtime?.status));
checks.push("ai:runtime-status");

const aiBatch = await json("/api/ai/batch?identifySpecies=0&mode=fast");
assert.equal(aiBatch.response.status, 200);
assert.equal(aiBatch.body.status.total, health.body.webEvents);
assert.equal(typeof aiBatch.body.status.active, "boolean");
assert.equal(typeof aiBatch.body.status.paused, "boolean");
assert.equal(aiBatch.body.status.identifySpecies, false);
assert.equal(aiBatch.body.status.mode, "fast");
checks.push("ai:batch-status");

const aiBatchSpecies = await json("/api/ai/batch?identifySpecies=1&mode=full");
assert.equal(aiBatchSpecies.response.status, 200);
assert.equal(aiBatchSpecies.body.status.total, health.body.webEvents);
assert.equal(aiBatchSpecies.body.status.identifySpecies, true);
assert.equal(aiBatchSpecies.body.status.mode, "full");
checks.push("ai:independent-species-option");

const rejectedReset = await json("/api/ai/reset", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(rejectedReset.response.status, 400);
const rejectedClear = await json("/api/workspace/clear", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(rejectedClear.response.status, 400);
checks.push("safety:destructive-controls-require-confirmation");

const invalidAiJob = await json("/api/ai/jobs", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ EventID: "DOES-NOT-EXIST" }),
});
assert.ok([400, 503].includes(invalidAiJob.response.status));
checks.push("ai:invalid-job-rejected");

const eventPayload = await json("/api/events");
assert.equal(eventPayload.response.status, 200);
assert.equal(eventPayload.body.events.length, health.body.events);
const registeredEvents = eventPayload.body.events.filter((event) => event.SourceType !== "web_upload");
assert.equal(registeredEvents.length, 154);
const first = registeredEvents[0];
assert.ok(first.EventID);
assert.ok(first.media.Photo1);
assert.equal(first.SchemaVersion, "2.1");
assert.ok(first.AIStatus);
assert.equal(typeof first.HumanLabels, "string");
checks.push("events:loaded");

const taxonomyPayload = await json("/api/taxonomy");
assert.ok(taxonomyPayload.body.taxonomy.some((item) => item.taxonCode === "ANIMAL_UNKNOWN"));
assert.ok(taxonomyPayload.body.taxonomy.some((item) => item.taxonCode === "MURIDAE_SP"));
checks.push("taxonomy:conservative-labels");

const imageResponse = await fetch(`${baseUrl}${first.media.Photo1}`, { headers: { Range: "bytes=0-1" } });
assert.equal(imageResponse.status, 206);
const magic = new Uint8Array(await imageResponse.arrayBuffer());
assert.deepEqual([...magic], [0xff, 0xd8]);
checks.push("media:jpeg-range");

const traversal = await fetch(`${baseUrl}/media/${encodeURIComponent("../config.json")}`);
assert.equal(traversal.status, 404);
checks.push("security:path-traversal-blocked");

const invalid = await json("/api/annotations", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ EventID: first.EventID, DeploymentID: "tamper" }),
});
assert.equal(invalid.response.status, 400);
checks.push("security:immutable-field-blocked");

const immutableAi = await json("/api/annotations", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ EventID: first.EventID, AIStatus: "AI_COMPLETE" }),
});
assert.equal(immutableAi.response.status, 400);
checks.push("security:ai-fields-immutable");

const invalidLabels = await json("/api/annotations", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ EventID: first.EventID, HumanLabels: "empty;animal" }),
});
assert.equal(invalidLabels.response.status, 400);
checks.push("validation:exclusive-empty-label");

if (allowWrite) {
  const saved = await json("/api/annotations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      EventID: first.EventID,
      PhotoOnlyDecision: "uncertain",
      FinalDecision: "uncertain",
      VisibleClass: "uncertain",
      TaxonCode: "ANIMAL_UNKNOWN",
      CommonName: "未知動物",
      ReviewerConfidence: "low",
      ReviewStatus: "first_pass",
      FirstPassDate: "2026-08-11",
      Notes: "SMOKE_TEST_ONLY",
      HumanLabels: "uncertain",
      IndividualCountMax: "",
      CorrectionReason: "自動寫入與稽核測試",
      TaxonomyVersion: "taxonomy_v1.0",
    }),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.event.Notes, "SMOKE_TEST_ONLY");
  assert.equal(saved.body.event.HumanLabels, "uncertain");
  assert.equal(saved.body.event.SchemaVersion, "2.1");
  assert.ok(saved.body.event.LastModifiedAt);
  const exportResponse = await fetch(`${baseUrl}/api/export.csv`);
  const csv = await exportResponse.text();
  assert.ok(csv.includes("SMOKE_TEST_ONLY"));
  checks.push("write:save-and-export");
}

if (allowImport) {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const uploadFiles = [
    { path: "SMOKE/IMG_0001.JPG", type: "image/jpeg", bytes: jpeg, modified: "2026-08-18T01:00:00.000Z" },
    { path: "SMOKE/IMG_0002.JPG", type: "image/jpeg", bytes: jpeg, modified: "2026-08-18T01:00:01.000Z" },
    { path: "SMOKE/IMG_0003.JPG", type: "image/jpeg", bytes: jpeg, modified: "2026-08-18T01:00:02.000Z" },
    { path: "SMOKE/VID_0001.MP4", type: "video/mp4", bytes: mp4, modified: "2026-08-18T01:00:03.000Z" },
  ];
  const createdImport = await json("/api/imports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deploymentName: "SMOKE-WEB",
      media: uploadFiles.map((file) => ({
        relativePath: file.path,
        filename: file.path.split("/").at(-1),
        size: file.bytes.byteLength,
        mimeType: file.type,
        lastModified: file.modified,
        sha256: "SERVER_CALCULATED",
      })),
    }),
  });
  assert.equal(createdImport.response.status, 201);
  const importId = createdImport.body.import.importId;
  for (const [index, file] of uploadFiles.entries()) {
    const response = await fetch(`${baseUrl}/api/imports/${encodeURIComponent(importId)}/files/${index}`, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file.bytes,
    });
    const payload = await response.json();
    assert.equal(response.status, 200, payload.error);
    assert.match(payload.file.sha256, /^[a-f0-9]{64}$/);
  }
  const finalized = await json(`/api/imports/${encodeURIComponent(importId)}/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(finalized.response.status, 201);
  assert.equal(finalized.body.import.status, "COMPLETE");
  assert.equal(finalized.body.import.eventIds.length, 1);
  const importedEventId = finalized.body.import.eventIds[0];
  const refreshed = await json("/api/events");
  const imported = refreshed.body.events.find((event) => event.EventID === importedEventId);
  assert.equal(imported.SourceType, "web_upload");
  assert.equal(imported.SchemaVersion, "2.1");
  assert.ok(imported.media.Photo1);
  assert.ok(imported.media.Video);
  const importedImage = await fetch(`${baseUrl}${imported.media.Photo1}`, { headers: { Range: "bytes=0-1" } });
  assert.equal(importedImage.status, 206);
  assert.deepEqual([...new Uint8Array(await importedImage.arrayBuffer())], [0xff, 0xd8]);
  const exportResponse = await fetch(`${baseUrl}/api/export.csv`);
  assert.match(await exportResponse.text(), new RegExp(importedEventId));
  checks.push("upload:media-verified-and-event-created");
}

console.log(JSON.stringify({ ok: true, baseUrl, checks }, null, 2));
