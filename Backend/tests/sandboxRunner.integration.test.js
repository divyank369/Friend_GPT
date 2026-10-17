import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDockerCommandRunner } from "../../SandboxRunner/dockerCommand.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runnerPath = path.join(root, "SandboxRunner", "server.js");
const fakeDockerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fakeDocker.js");
const token = "sandbox-runner-integration-test-token-123456";
const processes = [];
const dataDirectories = [];

async function availablePort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function startRunner() {
  const port = await availablePort();
  const dataDir = await mkdtemp(path.join(tmpdir(), "sigma-preview-test-"));
  dataDirectories.push(dataDir);
  const child = spawn(process.execPath, [runnerPath], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      SANDBOX_SERVICE_TOKEN: token,
      SANDBOX_DATA_DIR: dataDir,
      SANDBOX_NODE_IMAGE: "test-node-image",
      SANDBOX_PUBLIC_ORIGIN: "http://localhost:8090",
      SANDBOX_FRAME_ORIGINS: "http://localhost:5173",
      SANDBOX_DOCKER_BIN: process.execPath,
      SANDBOX_DOCKER_PREFIX_ARGS: JSON.stringify([fakeDockerPath])
    }
  });
  processes.push(child);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (child.exitCode !== null) throw new Error("Sandbox runner failed to start");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return `http://127.0.0.1:${port}`;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Sandbox runner did not become ready");
}

after(async () => {
  for (const child of processes) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1000).unref();
    });
  }
  await Promise.all(dataDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("sandbox runner requires its service token and rejects unsafe project input", async () => {
  const baseUrl = await startRunner();
  const unauthenticated = await fetch(`${baseUrl}/v1/sessions`, { method: "POST" });
  assert.equal(unauthenticated.status, 401);

  const traversal = {
    projectType: "react-vite",
    files: [
      { path: "index.html", content: "<div id='root'></div>" },
      { path: "package.json", content: JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", vite: "^6.0.0" } }) },
      { path: "../outside.js", content: "bad" }
    ]
  };
  const invalid = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: "a7614d5b-9923-4be0-9d23-a4539b78c8f9", previewToken: "a".repeat(64), project: traversal })
  });
  assert.equal(invalid.status, 400);

  const buildWithoutSession = await fetch(`${baseUrl}/v1/sessions/a7614d5b-9923-4be0-9d23-a4539b78c8f9/build`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(buildWithoutSession.status, 409, "production build export requires a ready preview session");
});

test("sandbox runner lifecycle reports build failures and allows session cleanup", async () => {
  const baseUrl = await startRunner();
  const sessionId = "b7614d5b-9923-4be0-9d23-a4539b78c8f9";
  const project = {
    projectType: "react-vite",
    files: [
      { path: "index.html", content: "<div id='root'></div>" },
      { path: "package.json", content: JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", vite: "^6.0.0" } }) },
      { path: "src/App.jsx", content: "export default function App() { return <main />; }" }
    ]
  };
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const started = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST", headers, body: JSON.stringify({ sessionId, previewToken: "b".repeat(64), project })
  });
  assert.equal(started.status, 202);
  let state;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${token}` } });
    state = await response.json();
    if (state.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(state.status, "failed");
  assert.equal(state.error, "The isolated project could not be built or started.", "the runner exposes only a generic user-safe error");
  assert.equal(state.diagnostics.category, "dependencies");
  assert.equal(state.diagnostics.logs.includes("private-build-key"), false, "diagnostics redact credential-shaped values");

  const stopped = await fetch(`${baseUrl}/v1/sessions/${sessionId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).status, "stopped");
});

test("container command runner enforces timeout and hides command output on failure", async () => {
  let killSignal;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    killSignal = signal;
    queueMicrotask(() => child.emit("close", null, signal));
  };
  const run = createDockerCommandRunner({ spawnProcess: () => child });
  const timed = run(["run", "untrusted-project"], { timeout: 10 });
  await assert.rejects(timed, (error) => {
    assert.equal(error.timedOut, true);
    assert.equal(error.message, "Sandbox task failed");
    return true;
  });
  assert.equal(killSignal, "SIGKILL");
});
