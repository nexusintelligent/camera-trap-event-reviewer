import assert from "node:assert/strict";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:4173";
const allowWrite = process.env.SMOKE_ALLOW_WRITE === "1";

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
checks.push("pwa:html-metadata");

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
assert.equal(health.body.events, 154);
checks.push("health:154-events");

const configPayload = await json("/api/config");
assert.equal(configPayload.response.status, 200);
assert.equal(configPayload.body.schemaVersion, "2.0");
assert.equal(typeof configPayload.body.inferenceAvailable, "boolean");
assert.equal(typeof configPayload.body.aiRuntime?.status, "string");
assert.ok(configPayload.body.auditLog);
checks.push("config:v2-capabilities");

const aiStatus = await json("/api/ai/status");
assert.equal(aiStatus.response.status, 200);
assert.equal(typeof aiStatus.body.runtime?.ready, "boolean");
assert.ok(["READY", "NOT_INSTALLED", "BROKEN"].includes(aiStatus.body.runtime?.status));
checks.push("ai:runtime-status");

const invalidAiJob = await json("/api/ai/jobs", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ EventID: "DOES-NOT-EXIST" }),
});
assert.ok([400, 503].includes(invalidAiJob.response.status));
checks.push("ai:invalid-job-rejected");

const eventPayload = await json("/api/events");
assert.equal(eventPayload.response.status, 200);
assert.equal(eventPayload.body.events.length, 154);
const first = eventPayload.body.events[0];
assert.ok(first.EventID);
assert.ok(first.media.Photo1);
assert.equal(first.SchemaVersion, "2.0");
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
  assert.equal(saved.body.event.SchemaVersion, "2.0");
  assert.ok(saved.body.event.LastModifiedAt);
  const exportResponse = await fetch(`${baseUrl}/api/export.csv`);
  const csv = await exportResponse.text();
  assert.ok(csv.includes("SMOKE_TEST_ONLY"));
  checks.push("write:save-and-export");
}

console.log(JSON.stringify({ ok: true, baseUrl, checks }, null, 2));
