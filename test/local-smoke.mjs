import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "camera-trap-local-smoke-"));
const port = 43173 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let stdout = "";
let stderr = "";

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: { ...process.env, CAMTRAP_PORT: String(port), LOCALAPPDATA: runtimeRoot },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (chunk) => { stdout += chunk; });
server.stderr.on("data", (chunk) => { stderr += chunk; });

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response;
    } catch {
      // The server is still preparing the empty local workspace.
    }
    await wait(100);
  }
  throw new Error(`本機服務未在預期時間啟動。\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function stopServer() {
  if (server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  await Promise.race([exited, wait(3000)]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

try {
  const health = await waitForHealth();
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.events, 0, "全新使用者應從空白工作區啟動");
  assert.equal(healthBody.registeredEvents, 0);

  const [configResponse, eventsResponse, taxonomyResponse, shellResponse] = await Promise.all([
    fetch(`${baseUrl}/api/config`),
    fetch(`${baseUrl}/api/events`),
    fetch(`${baseUrl}/api/taxonomy`),
    fetch(`${baseUrl}/`),
  ]);
  assert.equal(configResponse.status, 200);
  assert.equal(eventsResponse.status, 200);
  assert.equal(taxonomyResponse.status, 200);
  assert.equal(shellResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(config.appName, "相機陷阱本機辨識器");
  assert.ok(!config.workingCsv.includes("CameraTrap_Gold"));
  assert.ok(!config.workingCsv.includes("%LOCALAPPDATA%"), "Windows environment variables should be expanded");
  if (process.platform === "win32") {
    assert.equal(config.workingCsv, path.join(runtimeRoot, "CameraTrapReviewer", "data", "reviewed-events.csv"));
  }
  assert.deepEqual((await eventsResponse.json()).events, []);
  assert.ok((await taxonomyResponse.json()).taxonomy.length > 0);

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLq7wAAAABJRU5ErkJggg==", "base64");
  const importResponse = await fetch(`${baseUrl}/api/imports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "2.1",
      deploymentName: "local-smoke",
      media: [{
        relativePath: "CAM001/IMG_0001.png",
        size: png.length,
        mimeType: "image/png",
        lastModified: "2026-08-30T00:00:00.000Z",
        sha256: "SERVER_CALCULATED",
      }],
    }),
  });
  assert.equal(importResponse.status, 201);
  const importSession = (await importResponse.json()).import;
  const uploadResponse = await fetch(`${baseUrl}/api/imports/${encodeURIComponent(importSession.importId)}/files/0`, {
    method: "POST",
    headers: { "Content-Type": "image/png", "Content-Length": String(png.length) },
    body: png,
  });
  assert.equal(uploadResponse.status, 200);
  const finalizeResponse = await fetch(`${baseUrl}/api/imports/${encodeURIComponent(importSession.importId)}/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(finalizeResponse.status, 201);
  const importedEvents = (await (await fetch(`${baseUrl}/api/events`)).json()).events;
  assert.equal(importedEvents.length, 1);
  assert.equal(importedEvents[0].SourceType, "web_upload");
  assert.equal((await fetch(`${baseUrl}/api/export.csv`)).status, 200);

  const allowedOrigin = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: "https://nexusintelligent.github.io" },
  });
  assert.equal(allowedOrigin.status, 200);
  assert.equal(allowedOrigin.headers.get("access-control-allow-origin"), "https://nexusintelligent.github.io");

  const rejectedOrigin = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: "https://malicious.example" },
  });
  assert.equal(rejectedOrigin.status, 403);
  console.log("PASS local-first empty workspace, local API, and GitHub Pages CORS");
} finally {
  await stopServer();
  await rm(runtimeRoot, { recursive: true, force: true });
}
