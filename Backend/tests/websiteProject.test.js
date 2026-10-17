import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { createServer } from "node:http";
import websiteBuilderRoutes from "../routes/websiteBuilder.js";
import PreviewSession from "../models/PreviewSession.js";
import { MAX_PROJECT_FILES, validateReactPreviewProject, validateWebsiteProject } from "../utils/websiteProject.js";
import { callSandbox } from "../utils/sandboxService.js";

const originalSecret = process.env.AUTH_JWT_SECRET;
const originalFetch = globalThis.fetch;
const originalSandboxUrl = process.env.SANDBOX_SERVICE_URL;
const originalSandboxToken = process.env.SANDBOX_SERVICE_TOKEN;
const originalPreviewUrl = process.env.SANDBOX_PREVIEW_BASE_URL;
const validUserId = "507f1f77bcf86cd799439011";
const secret = "website-builder-test-secret-that-is-long-enough";
afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.AUTH_JWT_SECRET;
  else process.env.AUTH_JWT_SECRET = originalSecret;
  if (originalSandboxUrl === undefined) delete process.env.SANDBOX_SERVICE_URL;
  else process.env.SANDBOX_SERVICE_URL = originalSandboxUrl;
  if (originalSandboxToken === undefined) delete process.env.SANDBOX_SERVICE_TOKEN;
  else process.env.SANDBOX_SERVICE_TOKEN = originalSandboxToken;
  if (originalPreviewUrl === undefined) delete process.env.SANDBOX_PREVIEW_BASE_URL;
  else process.env.SANDBOX_PREVIEW_BASE_URL = originalPreviewUrl;
});

const validProject = {
  projectType: "react-vite",
  name: "Portfolio",
  files: [
    { path: "index.html", content: "<div id='root'></div>" },
    { path: "package.json", content: JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", vite: "^6.0.0" } }) },
    { path: "src/App.jsx", content: "export default function App() { return <main />; }" }
  ]
};

test("accepts structured React and static website projects", () => {
  assert.equal(validateWebsiteProject(validProject).files[2].path, "src/App.jsx");
  assert.equal(validateWebsiteProject({ ...validProject, projectType: "html-css-js", files: [{ path: "index.html", content: "<main>Hello</main>" }] }).projectType, "html-css-js");
});

test("rejects traversal, absolute paths, backslashes, and unsupported file types", () => {
  for (const path of ["../secret.js", "src/../../secret.js", "/etc/passwd.js", "C:/secret.js", "src\\App.jsx", "run.sh"]) {
    assert.throws(() => validateWebsiteProject({ ...validProject, files: [{ path, content: "x" }] }), /path/);
  }
});

test("rejects duplicate paths, excessive file counts, and oversized files", () => {
  assert.throws(() => validateWebsiteProject({ ...validProject, files: [validProject.files[0], validProject.files[0]] }), /path/);
  assert.equal(MAX_PROJECT_FILES, 30);
  assert.throws(() => validateWebsiteProject({ ...validProject, files: Array.from({ length: 31 }, (_, index) => ({ path: `src/${index}.js`, content: "" })) }), /format/);
  assert.throws(() => validateWebsiteProject({ ...validProject, files: [{ path: "src/App.jsx", content: "x".repeat(30001) }] }), /size/);
});

test("rejects malformed model output and unsupported project types", () => {
  assert.throws(() => validateWebsiteProject("not json"), /structured data/);
  assert.throws(() => validateWebsiteProject({ ...validProject, projectType: "python" }), /format/);
});

test("preview validation accepts only bounded React + Vite dependencies", () => {
  assert.equal(validateReactPreviewProject(validProject).projectType, "react-vite");
  assert.throws(() => validateReactPreviewProject({ ...validProject, projectType: "html-css-js" }), /React \+ Vite/);
  const packageFile = validProject.files[1];
  const hostile = { ...validProject, files: validProject.files.map((file) => file === packageFile ? { ...file, content: JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", vite: "^6.0.0", "evil-package": "1.0.0" } }) } : file) };
  assert.throws(() => validateReactPreviewProject(hostile), /supports React/);
  const traversal = { ...validProject, files: [...validProject.files, { path: "../outside.js", content: "bad" }] };
  assert.throws(() => validateReactPreviewProject(traversal), /path/);
});

test("sandbox service request times out and hides transport details", async () => {
  process.env.SANDBOX_SERVICE_URL = "https://runner.internal";
  process.env.SANDBOX_SERVICE_TOKEN = "a-private-test-token-that-is-long-enough";
  process.env.SANDBOX_PREVIEW_BASE_URL = "https://preview.example.test";
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("socket details")), { once: true });
  });
  await assert.rejects(callSandbox("GET", "/v1/sessions/example", undefined, { timeoutMs: 10 }), (error) => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.message, "The isolated preview service is temporarily unavailable.");
    return true;
  });
});

test("preview lifecycle is authenticated, owner-scoped, and cleans up sessions", async () => {
  process.env.AUTH_JWT_SECRET = secret;
  process.env.SANDBOX_SERVICE_URL = "https://runner.internal";
  process.env.SANDBOX_SERVICE_TOKEN = "a-private-test-token-that-is-long-enough";
  process.env.SANDBOX_PREVIEW_BASE_URL = "https://preview.example.test";
  const session = {
    sessionId: "a7614d5b-9923-4be0-9d23-a4539b78c8f9",
    ownerId: validUserId,
    status: "building",
    previewToken: "a".repeat(64),
    projectFiles: validProject.files,
    expiresAt: new Date(Date.now() + 60_000),
    save: async () => {}
  };
  const originalPreviewToken = session.previewToken;
  let capturedQuery;
  mock.method(PreviewSession, "create", async () => session);
  mock.method(PreviewSession, "countDocuments", async () => 0);
  mock.method(PreviewSession, "findOne", (query) => {
    capturedQuery = query;
    return { select: async () => query.ownerId === validUserId ? session : null };
  });
  const sandboxRequests = [];
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith("https://runner.internal/")) return originalFetch(url, options);
    sandboxRequests.push({ url: String(url), method: options.method, authorization: options.headers.Authorization });
    return new Response(JSON.stringify({ status: "running" }), { status: 200 });
  };

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use("/api/website-builder", websiteBuilderRoutes);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cookie = `friendgpt_session=${jwt.sign({}, secret, { subject: validUserId, expiresIn: "1h" })}`;
  try {
    const start = await fetch(`${baseUrl}/api/website-builder/projects`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ project: validProject })
    });
    const startPayload = await start.json();
    assert.equal(start.status, 202, JSON.stringify(startPayload));
    assert.equal(startPayload.status, "building");

    const inspect = await fetch(`${baseUrl}/api/website-builder/projects/${session.sessionId}`, { headers: { Cookie: cookie } });
    const state = await inspect.json();
    assert.equal(state.status, "running");
    assert.equal(state.previewUrl, `https://preview.example.test/p/${session.previewToken}/`);
    assert.equal(capturedQuery.ownerId, validUserId);

    const otherUserCookie = `friendgpt_session=${jwt.sign({}, secret, { subject: "507f1f77bcf86cd799439012", expiresIn: "1h" })}`;
    const forbidden = await fetch(`${baseUrl}/api/website-builder/projects/${session.sessionId}`, { headers: { Cookie: otherUserCookie } });
    assert.equal(forbidden.status, 404);

    const invalidRepairLimit = await fetch(`${baseUrl}/api/website-builder/projects/${session.sessionId}/fix`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ maxAttempts: 4 })
    });
    assert.equal(invalidRepairLimit.status, 400);
    const unauthorizedRepair = await fetch(`${baseUrl}/api/website-builder/projects/${session.sessionId}/fix`, { method: "POST" });
    assert.equal(unauthorizedRepair.status, 401);

    const stop = await fetch(`${baseUrl}/api/website-builder/projects/${session.sessionId}`, { method: "DELETE", headers: { Cookie: cookie } });
    assert.equal(stop.status, 200);
    assert.equal((await stop.json()).status, "stopped");
    assert.notEqual(session.previewToken, originalPreviewToken);
    assert.ok(sandboxRequests.some((request) => request.method === "DELETE"));
    assert.ok(sandboxRequests.every((request) => request.authorization === `Bearer ${process.env.SANDBOX_SERVICE_TOKEN}`));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("website generation API requires a session and validates bounded input", async () => {
  process.env.AUTH_JWT_SECRET = secret;
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/website-builder", websiteBuilderRoutes);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cookie = `friendgpt_session=${jwt.sign({}, secret, { subject: validUserId, expiresIn: "1h" })}`;
  try {
    const unauthenticated = await fetch(`${baseUrl}/api/website-builder/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requirements: "Make a site" })
    });
    assert.equal(unauthenticated.status, 401);

    const invalidInput = await fetch(`${baseUrl}/api/website-builder/generate`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ requirements: " ".repeat(6001) })
    });
    assert.equal(invalidInput.status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
