import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

export class PersistentMegaDetectorWorker {
  constructor({ pythonPath, scriptPath, model, threshold, batchSize = 0, cwd, env = {} }) {
    this.options = { pythonPath, scriptPath, model, threshold, batchSize, cwd, env };
    this.child = null;
    this.ready = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.pending = new Map();
    this.stderr = "";
    this.startedAt = "";
    this.requests = 0;
  }

  publicStatus() {
    return {
      running: Boolean(this.child && this.child.exitCode === null),
      startedAt: this.startedAt,
      requests: this.requests,
      stderrTail: this.stderr.slice(-2000),
      ...(this.ready || {}),
    };
  }

  async ensureReady() {
    if (this.child && this.child.exitCode === null && this.ready) return this.ready;
    if (this.readyPromise) return this.readyPromise;
    const args = [
      this.options.scriptPath,
      "--model", this.options.model,
      "--threshold", String(this.options.threshold),
      "--batch-size", String(this.options.batchSize),
    ];
    this.startedAt = new Date().toISOString();
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.child = spawn(this.options.pythonPath, args, {
      cwd: this.options.cwd,
      windowsHide: true,
      shell: false,
      env: { ...process.env, PYTHONUTF8: "1", ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-100_000);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code, signal) => {
      this.failAll(new Error(`MegaDetector Worker 已結束（code=${code}, signal=${signal || "none"}）。`));
      this.child = null;
      this.ready = null;
      this.readyPromise = null;
    });
    return this.readyPromise;
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderr = `${this.stderr}\nUnexpected worker output: ${line}`.slice(-100_000);
      return;
    }
    if (message.type === "ready") {
      this.ready = message;
      this.readyResolve?.(message);
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.type === "error") pending.reject(new Error(message.error || "MegaDetector Worker 失敗。"));
    else pending.resolve(message);
  }

  failAll(error) {
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async detect(images) {
    await this.ensureReady();
    if (!Array.isArray(images) || !images.length) throw new Error("MegaDetector Worker 沒有收到照片。");
    const requestId = randomUUID();
    const response = new Promise((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
    this.child.stdin.write(`${JSON.stringify({ command: "detect", requestId, images })}\n`);
    this.requests += 1;
    return response;
  }

  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const closed = new Promise((resolve) => child.once("close", resolve));
    const requestId = randomUUID();
    child.stdin.write(`${JSON.stringify({ command: "shutdown", requestId })}\n`);
    const graceful = await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!graceful && child.exitCode === null) {
      child.kill();
      await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    }
  }
}
