// End-to-end workflow tests using small deterministic Python model doubles.
// No real model weights, user media or inference-accuracy claims are involved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { photoEntries, fastPhotoEntries, isVideoFile } from "../public/media-options.js";
import { PerformanceStore } from "../lib/performance-store.mjs";

const python = process.env.CAMTRAP_TEST_PYTHON;
assert.ok(python, "Set CAMTRAP_TEST_PYTHON to a Python 3 executable (no AI packages required)");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "camera-trap-regression-"));
const modules = path.join(temp, "modules");
const port = 45100 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server;
let logs = "";
async function fixture(name, content) {
  const target = path.join(modules, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
const pipeline = `import sys,json,time,pathlib
time.sleep(0.25)
args = sys.argv[1:]
species = 'speciesnet' in sys.argv[0]
source = pathlib.Path(args[0] if species else args[1])
target = pathlib.Path(args[1] if species else args[2])
photos = sorted(source.glob('*'))
if any('fail' in p.name for p in photos): raise RuntimeError('simulated inference failure')
target.write_text(json.dumps({'images':[{'file':p.name,'detections':[]} for p in photos],'detection_categories':{'1':'animal','2':'person','3':'vehicle'}}),encoding='utf-8')
`;

async function api(url, body) {
  const response = await fetch(base + url, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { code: response.status, ...payload };
}
function batchUrl(id, mode, species = false) {
  return `/api/ai/batch?deploymentId=${encodeURIComponent(id)}&mode=${mode}&identifySpecies=${species ? 1 : 0}`;
}
async function waitBatch(id, mode, species = false) {
  let sawLive = false;
  let sawPartial = false;
  let lastCount = 0;
  for (let i = 0; i < 240; i++) {
    const { status } = await api(batchUrl(id, mode, species));
    assert.ok(status.performance, JSON.stringify(status));
    const report = status.performance;
    assert.equal(report.deploymentId, id);
    assert.equal(report.mode, mode);
    assert.ok(report.processedPhotos >= lastCount);
    lastCount = report.processedPhotos;
    if (report.status === "RUNNING") sawLive = true;
    if (report.completedEvents > 0 && report.completedEvents < report.events) sawPartial = true;
    if (!status.active) return { report, sawLive, sawPartial };
    await pause(40);
  }
  throw new Error(`Batch did not finish: ${logs}`);
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLq7wAAAABJRU5ErkJggg==", "base64");
const video = Buffer.from("0000ftyp0000test-video");
function item(name, seconds = 0, folder = "cam") {
  const bytes = name.endsWith(".mp4") ? video : Buffer.concat([png, Buffer.from(name)]);
  return { bytes, relativePath: `${folder}/${name}`, size: bytes.length, lastModified: new Date(Date.UTC(2026, 8, 21, 0, 0, seconds)).toISOString() };
}
async function importBatch(name, photosPerEvent, includeVideos, files) {
  const result = await api("/api/imports", { deploymentName: name, photosPerEvent, includeVideos,
    media: files.map(({ bytes, ...fields }) => fields) });
  assert.equal(result.code, 201, JSON.stringify(result));
  assert.equal(result.import.photosPerEvent, photosPerEvent);
  assert.equal(result.import.includeVideos, includeVideos);
  for (let i = 0; i < files.length; i++) {
    const response = await fetch(`${base}/api/imports/${result.import.importId}/files/${i}`, { method: "POST", body: files[i].bytes });
    assert.equal(response.status, 200, await response.text());
  }
  const completed = await api(`/api/imports/${result.import.importId}/finalize`, {});
  assert.equal(completed.code, 201, JSON.stringify(completed));
  const events = (await api("/api/events")).events.filter((event) => event.DeploymentID === result.import.deploymentId);
  return { id: result.import.deploymentId, events };
}
async function startServer() {
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: root, windowsHide: true,
    env: { ...process.env, CAMTRAP_PORT: String(port), LOCALAPPDATA: temp,
      CAMTRAP_AI_PYTHON: python, PYTHONPATH: modules,
      CAMTRAP_AI_DETECTOR_MODEL_FILE: path.join(temp, "fake-model.pt"),
      CAMTRAP_MANIFEST_CSV: path.join(temp, "source.csv"), CAMTRAP_WORKING_CSV: path.join(temp, "work.csv"),
      CAMTRAP_AUDIT_LOG: path.join(temp, "audit.jsonl"), CAMTRAP_UPLOADS_ROOT: path.join(temp, "uploads"),
      CAMTRAP_AI_JOBS_ROOT: path.join(temp, "jobs"), CAMTRAP_AI_MODEL_CACHE: path.join(temp, "models"),
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { logs += chunk; });
  server.stderr.on("data", (chunk) => { logs += chunk; });
  for (let i = 0; i < 100; i++) {
    try { if ((await api("/api/health")).ok) return; } catch { /* Startup. */ }
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

try {
  assert.equal(isVideoFile("VIDEO.MP4"), true);
  assert.equal(isVideoFile("camera.mov"), true);
  assert.equal(isVideoFile("photo.jpg"), false);
  assert.equal(isVideoFile("frame.mp4.png"), false);
  await fixture("torch/__init__.py", `from types import SimpleNamespace
__version__='test-double'
cuda=SimpleNamespace(is_available=lambda:False,device_count=lambda:0)
version=SimpleNamespace(cuda=None)
`);
  for (const name of ["megadetector", "speciesnet"]) {
    await fixture(`${name}/__init__.py`, "");
    await fixture(`${name}-0.0.0.dist-info/METADATA`, `Name: ${name}\nVersion: 0.0.0\n`);
  }
  await fixture("megadetector/detection/__init__.py", "");
  await fixture("megadetector/visualization/__init__.py", "");
  await fixture("megadetector/detection/run_detector_batch.py", pipeline);
  await fixture("megadetector/detection/run_md_and_speciesnet.py", pipeline);
  await fixture("megadetector/detection/run_detector.py", `import time
class Detector:
    def generate_detections_one_batch(self,images,tokens,detection_threshold):
        time.sleep(0.16)
        return [{'file':token,'detections':[]} for token in tokens]
def load_detector(model): return Detector()
`);
  await fixture("megadetector/visualization/visualization_utils.py", `from pathlib import Path
class Image:
    mode='RGB'
    def copy(self): return self
    def thumbnail(self,size): pass
    def save(self,name,**kwargs): Path(name).write_bytes(b'test-thumbnail')
def load_image(path): return Image()
`);
  await fixture("cv2.py", `from pathlib import Path
CAP_PROP_FPS=5
class VideoCapture:
    def __init__(self,path): self.index=0
    def isOpened(self): return True
    def get(self,key): return 2
    def grab(self):
        self.index+=1
        return self.index<=5
    def retrieve(self): return True,b'frame'
    def release(self): pass
def imwrite(path,frame):
    Path(path).write_bytes(frame)
    return True
`);
  const model = await open(path.join(temp, "fake-model.pt"), "w");
  await model.truncate(50_000_001);
  await model.close();
  await startServer();
  assert.equal((await api("/api/config")).webUpload.importOptionsVersion, 1);
  const runtime = await api("/api/ai/status");
  assert.equal(runtime.runtime.ready, true, JSON.stringify(runtime));

  for (const value of [0, -1, 101, 1.5, "3"]) {
    assert.equal((await api("/api/imports", { photosPerEvent: value, media: [item("a.png")] })).code, 400);
  }
  assert.equal((await api("/api/imports", { includeVideos: "no", media: [item("a.png")] })).code, 400);
  assert.equal((await api("/api/imports", { includeVideos: false, media: [item("a.mp4")] })).code, 400);
  const a = await importBatch("five", 5, false, Array.from({ length: 7 }, (_, i) => item(`${i}.png`, i)));
  assert.deepEqual(a.events.map((e) => photoEntries(e).length), [5, 2]);
  assert.equal(a.events[0].ChallengeReasons, "");
  assert.equal(a.events[1].ChallengeReasons, "incomplete_pairing");
  assert.equal(fastPhotoEntries(a.events[0]).at(-1).field, "Photo5");
  assert.equal((await fetch(base + a.events[0].media.Photo5)).status, 200);
  const b = await importBatch("one", 1, false, [item("b1.png"), item("b2.png", 1)]);
  assert.equal(b.events.length, 2);
  const c = await importBatch("video", 2, true, [item("c1.png"), item("c2.png", 1), item("c3.mp4", 2)]);
  assert.equal(c.events.length, 1);
  assert.ok(c.events[0].media.Video);
  const boundaries = await importBatch("boundaries", 5, false, [item("a.png"), item("b.png", 200), item("c.png", 201, "other")]);
  assert.equal(boundaries.events.length, 3, "folder and time boundaries retained");
  assert.ok((await (await fetch(base + "/api/export.csv")).text()).includes("PhotoFiles"));

  await api("/api/ai/batch", { deploymentId: a.id, mode: "fast" });
  const first = await waitBatch(a.id, "fast");
  assert.equal(first.report.status, "COMPLETE", JSON.stringify(first));
  assert.equal(first.report.processedPhotos, 4);
  assert.equal(first.sawLive, true);
  assert.equal(first.sawPartial, true);
  await api("/api/ai/batch", { deploymentId: b.id, mode: "fast" });
  const second = await waitBatch(b.id, "fast");
  assert.equal(second.report.processedPhotos, 2);
  assert.notEqual(first.report.runId, second.report.runId);
  assert.equal((await api(batchUrl(a.id, "fast"))).status.performance.runId, first.report.runId);
  assert.equal((await api(batchUrl(a.id, "full"))).status.performance, null);

  await api("/api/ai/batch", { deploymentId: a.id, mode: "full", identifySpecies: false });
  const full = await waitBatch(a.id, "full");
  assert.equal(full.report.status, "COMPLETE", JSON.stringify(full));
  assert.equal(full.report.processedPhotos, 7);
  assert.equal(full.sawPartial, true);
  assert.ok(full.report.timingsSeconds.pipelineInference > 0);
  assert.equal(full.report.modelLoadCountThisBatch, null, "unknown load count must not be invented");
  await api("/api/ai/batch", { deploymentId: c.id, mode: "full", identifySpecies: false });
  const videoRun = await waitBatch(c.id, "full");
  assert.equal(videoRun.report.status, "COMPLETE", JSON.stringify(videoRun));
  assert.equal(videoRun.report.videosOpened, 1);
  assert.equal(videoRun.report.videoFramesDecoded, 3);
  const single = await api("/api/ai/jobs", { EventID: c.events[0].EventID, mode: "full", identifySpecies: true });
  assert.equal(single.code, 202, JSON.stringify(single));
  const species = await waitBatch(c.id, "full", true);
  assert.equal(species.report.status, "COMPLETE", JSON.stringify(species));
  assert.equal(species.report.videoFramesDecoded, 3);

  const bad = await importBatch("failure", 1, false, [item("fail.png")]);
  await api("/api/ai/batch", { deploymentId: bad.id, mode: "full" });
  const failed = await waitBatch(bad.id, "full");
  assert.equal(failed.report.status, "FAILED");
  assert.equal(failed.report.failedEvents, 1);
  assert.equal(failed.report.processedPhotos, 0);

  await stopServer();
  await startServer();
  const reloaded = (await api("/api/events")).events.find((event) => event.EventID === a.events[0].EventID);
  assert.equal(photoEntries(reloaded).length, 5, "extra photos survive CSV reload");
  assert.equal((await fetch(base + reloaded.media.Photo5)).status, 200);
  assert.equal((await api(batchUrl(a.id, "full"))).status.performance.runId, full.report.runId);
  await api("/api/ai/reset", { deploymentId: a.id, confirm: "RESET_AI_BATCH" });
  assert.equal((await api(batchUrl(a.id, "fast"))).status.performance, null);
  await api("/api/ai/batch", { deploymentId: a.id, mode: "fast" });
  const again = await waitBatch(a.id, "fast");
  assert.notEqual(again.report.runId, first.report.runId);
  assert.equal(again.report.processedPhotos, 4);
  assert.equal(again.report.detectionCacheHits, 4);

  // Reports in progress at shutdown are explicitly marked interrupted on reload.
  const storeFile = path.join(temp, "store.json");
  const store = new PerformanceStore(storeFile);
  const entry = { job: { status: "AI_RUNNING" }, event: { DeploymentID: "pause", EventID: "1" } };
  const run = store.create([entry], "full", false, { photos: 1, videos: 0 });
  store.start(run);
  await store.waiting(run, () => pause(80));
  assert.ok(store.snapshot(run).timingsSeconds.total < 0.07, "pause not counted as processing");
  await store.persist();
  const restored = new PerformanceStore(storeFile);
  await restored.load();
  assert.equal(restored.get("pause", "full").status, "INTERRUPTED");
  assert.equal(restored.isActive(), false);
  console.log("PASS grouping 1/5/remainders/boundaries, video exclusion+sampling, CSV reload, fast/full/species live performance, second batch, cache retry, failures and interrupted runs (model doubles)");
} finally {
  await stopServer();
  await rm(temp, { recursive: true, force: true });
}
