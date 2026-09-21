import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";

const keyFor = (deploymentId, mode, identifySpecies) => JSON.stringify([deploymentId, mode, Boolean(identifySpecies)]);
const terminal = new Set(["AI_COMPLETE", "FAILED", "CANCELLED"]);

// One latest run per import batch AND recognition mode/goal. Live reports never
// fall back to a different batch. Whole snapshots are atomically persisted.
export class PerformanceStore {
  constructor(filename) {
    this.filename = filename;
    this.runs = new Map();
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.filename, "utf8"));
      for (const report of data.reports || []) {
        if (!report.deploymentId || !report.runId) continue;
        if (["QUEUED", "RUNNING"].includes(report.status)) report.status = "INTERRUPTED";
        this.runs.set(keyFor(report.deploymentId, report.mode, report.identifySpecies), { report });
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }

  create(entries, mode, identifySpecies, mediaCounts) {
    const report = {
      schemaVersion: 2, runId: randomUUID(), deploymentId: entries[0].event.DeploymentID,
      mode, identifySpecies, status: "QUEUED", createdAt: new Date().toISOString(),
      events: entries.length, completedEvents: 0, failedEvents: 0, cancelledEvents: 0,
      requestedPhotos: mediaCounts.photos, requestedVideos: mediaCounts.videos,
      processedPhotos: 0, inferredPhotos: 0, videosOpened: 0, videoFramesDecoded: 0,
      detectionCacheHits: mode === "fast" ? 0 : null,
      modelLoadCountThisBatch: mode === "fast" ? 0 : null,
      pythonSubprocessesCreated: 0, timingsSeconds: {}, averageSecondsPerRequestedPhoto: null,
    };
    const run = { report, entries, elapsedBefore: 0, clock: null };
    this.runs.set(keyFor(report.deploymentId, mode, identifySpecies), run);
    for (const { job } of entries) job.performanceRunId = report.runId;
    return run;
  }

  start(run) {
    run.clock = performance.now();
    run.report.startedAt = new Date().toISOString();
    run.report.status = "RUNNING";
  }

  async waiting(run, wait) {
    this.stopClock(run);
    try { await wait(); } finally { run.clock = performance.now(); }
  }

  stopClock(run) {
    if (run.clock !== null) run.elapsedBefore += (performance.now() - run.clock) / 1000;
    run.clock = null;
  }

  snapshot(run) {
    if (!run) return null;
    const report = structuredClone(run.report);
    if (run.entries) {
      report.completedEvents = run.entries.filter(({ job }) => job.status === "AI_COMPLETE").length;
      report.failedEvents = run.entries.filter(({ job }) => job.status === "FAILED").length;
      report.cancelledEvents = run.entries.filter(({ job }) => job.status === "CANCELLED").length;
      report.currentEventId = run.entries.find(({ job }) => job.status === "AI_RUNNING")?.event.EventID || "";
      report.timingsSeconds.total = Number((run.elapsedBefore + (run.clock === null ? 0 : (performance.now() - run.clock) / 1000)).toFixed(4));
      const finished = report.completedEvents + report.failedEvents + report.cancelledEvents;
      if (report.status === "RUNNING" && finished < report.events) report.remainingEvents = report.events - finished;
      // A partial average only uses completed work, not the entire planned batch.
      report.averageSecondsPerRequestedPhoto = report.processedPhotos > 0
        ? report.timingsSeconds.total / report.processedPhotos : null;
    }
    return report;
  }

  get(deploymentId, mode, identifySpecies = false) {
    return this.snapshot(this.runs.get(keyFor(deploymentId, mode, identifySpecies)));
  }

  isActive(deploymentId) {
    return [...this.runs.values()].some(({ report }) => (!deploymentId || report.deploymentId === deploymentId)
      && ["QUEUED", "RUNNING"].includes(report.status));
  }

  update(run, fields) {
    Object.assign(run.report, fields, { updatedAt: new Date().toISOString() });
  }

  add(run, metrics) {
    for (const [key, value] of Object.entries(metrics)) {
      if (key === "timingsSeconds") {
        for (const [stage, seconds] of Object.entries(value)) run.report.timingsSeconds[stage] = (run.report.timingsSeconds[stage] || 0) + seconds;
      } else if (typeof value === "number" && !["device", "cudaAvailable"].includes(key)) {
        run.report[key] = (run.report[key] || 0) + value;
      } else run.report[key] = value;
    }
    run.report.updatedAt = new Date().toISOString();
  }

  async finish(run) {
    this.stopClock(run);
    run.report.status = run.entries.some(({ job }) => job.status === "FAILED") ? "FAILED"
      : run.entries.some(({ job }) => job.status === "CANCELLED") ? "CANCELLED"
      : run.entries.every(({ job }) => terminal.has(job.status)) ? "COMPLETE" : "INTERRUPTED";
    run.report.completedAt = new Date().toISOString();
    run.report = this.snapshot(run);
    delete run.entries;
    await this.persist();
  }

  async remove(deploymentId) {
    for (const [key, run] of this.runs) if (run.report.deploymentId === deploymentId) this.runs.delete(key);
    await this.persist();
  }

  persist() {
    const write = async () => {
      const temporary = `${this.filename}.tmp`;
      await writeFile(temporary, JSON.stringify({ schemaVersion: 2, reports: [...this.runs.values()].map((run) => this.snapshot(run)) }), "utf8");
      await rename(temporary, this.filename);
    };
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}
