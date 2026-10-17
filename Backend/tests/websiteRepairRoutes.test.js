import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { createServer } from "node:http";
import websiteBuilderRoutes from "../routes/websiteBuilder.js";
import PreviewSession from "../models/PreviewSession.js";

const savedEnv = Object.fromEntries(["AUTH_JWT_SECRET", "GROQ_API_KEY", "GROQ_MODEL", "GROQ_API_URL", "SANDBOX_SERVICE_URL", "SANDBOX_SERVICE_TOKEN", "SANDBOX_PREVIEW_BASE_URL"].map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const userId = "507f1f77bcf86cd799439011";
const secret = "website-repair-route-test-secret-long-enough";
const originalContent = "export default function App(){return <main>{`</main>};}";
const patchedContent = "export default function App(){return <main/>;}";

afterEach(() => {
  mock.restoreAll(); globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function setup({ candidateStatus = "running" } = {}) {
  process.env.AUTH_JWT_SECRET = secret;
  process.env.GROQ_API_KEY = "test-provider-key";
  process.env.GROQ_MODEL = "test-repair-model";
  process.env.SANDBOX_SERVICE_URL = "https://runner.internal";
  process.env.SANDBOX_SERVICE_TOKEN = "repair-test-sandbox-token-at-least-32";
  process.env.SANDBOX_PREVIEW_BASE_URL = "https://preview.example.test";
  const session = {
    sessionId: "b7614d5b-9923-4be0-9d23-a4539b78c8f9", runnerSessionId: "c7614d5b-9923-4be0-9d23-a4539b78c8f9",
    ownerId: userId, status: "running", previewToken: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000),
    projectName: "Test", projectFiles: [
      { path: "index.html", content: "<div id='root'></div>" },
      { path: "package.json", content: JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", vite: "^6.0.0" } }) },
      { path: "src/App.jsx", content: originalContent },
      { path: "src/style.css", content: "body { color: black }" }
    ], revisions: [], repair: null, markModified() {}, async save() {}
  };
  mock.method(PreviewSession, "findOne", (query) => ({ select: async () => query.ownerId === userId ? session : null }));
  const runnerRequests = [];
  let providerCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1:")) return originalFetch(url, options);
    if (target.startsWith("https://runner.internal/")) {
      const pathname = new URL(target).pathname;
      runnerRequests.push({ method: options.method, pathname });
      if (options.method === "POST" && pathname === "/v1/sessions") return Response.json({ status: "building" }, { status: 202 });
      if (options.method === "DELETE") return Response.json({ status: "stopped" });
      if (options.method === "GET" && pathname.endsWith(session.runnerSessionId)) {
        return Response.json({ status: "running", diagnostics: { category: "runtime", message: "Syntax error detected.", logs: "src/App.jsx: SyntaxError" } });
      }
      if (options.method === "GET") {
        return candidateStatus === "running"
          ? Response.json({ status: "running" })
          : Response.json({ status: "failed", diagnostics: { category: "runtime", message: "Syntax error persists.", logs: "SyntaxError in src/App.jsx" } });
      }
    }
    if (target.startsWith("https://api.groq.com/")) {
      providerCalls += 1;
      const response = JSON.stringify({ summary: "Fix the JSX syntax", changes: [{ path: "src/App.jsx", content: patchedContent }] });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: response } }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`Unexpected network request in test: ${target}`);
  };
  const app = express(); app.use(express.json({ limit: "1mb" })); app.use(cookieParser()); app.use("/api/website-builder", websiteBuilderRoutes);
  const server = createServer(app); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `friendgpt_session=${jwt.sign({}, secret, { subject: userId, expiresIn: "1h" })}`;
  return { server, base, cookie, session, runnerRequests, get providerCalls() { return providerCalls; } };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail("repair operation did not finish");
}

test("repair requires authentication and explicit patch approval, then refreshes the preview and records a revision", async () => {
  const context = await setup();
  try {
    const unauthorized = await fetch(`${context.base}/api/website-builder/projects/${context.session.sessionId}/fix`, { method: "POST" });
    assert.equal(unauthorized.status, 401);
    const otherCookie = `friendgpt_session=${jwt.sign({}, secret, { subject: "507f1f77bcf86cd799439012", expiresIn: "1h" })}`;
    const forbidden = await fetch(`${context.base}/api/website-builder/projects/${context.session.sessionId}/fix`, { method: "POST", headers: { Cookie: otherCookie } });
    assert.equal(forbidden.status, 404);

    const proposalResponse = await fetch(`${context.base}/api/website-builder/projects/${context.session.sessionId}/fix`, { method: "POST", headers: { Cookie: context.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ maxAttempts: 3 }) });
    const proposal = await proposalResponse.json();
    assert.equal(proposalResponse.status, 200);
    assert.equal(proposal.repair.status, "awaiting-confirmation");
    assert.equal(proposal.repair.changes[0].path, "src/App.jsx");
    assert.equal(context.session.projectFiles[2].content, originalContent, "analysis alone does not modify project files");
    assert.equal(context.runnerRequests.some((request) => request.method === "POST" && request.pathname === "/v1/sessions"), false);

    const applyResponse = await fetch(`${context.base}/api/website-builder/projects/${context.session.sessionId}/fix/apply`, { method: "POST", headers: { Cookie: context.cookie } });
    assert.equal(applyResponse.status, 202);
    await waitFor(() => context.session.repair?.status === "preview-updated");
    assert.equal(context.session.projectFiles[2].content, patchedContent);
    assert.equal(context.session.revisions.length, 1);
    assert.equal(context.session.revisions[0].changes[0].before, originalContent);
    assert.notEqual(context.session.runnerSessionId, "c7614d5b-9923-4be0-9d23-a4539b78c8f9");
    assert.ok(context.runnerRequests.some((request) => request.method === "DELETE" && request.pathname.endsWith("c7614d5b-9923-4be0-9d23-a4539b78c8f9")));
  } finally { context.server.closeAllConnections(); await new Promise((resolve) => context.server.close(resolve)); }
});

test("a repeated failed patch stops the bounded repair and preserves the old revision", async () => {
  const context = await setup({ candidateStatus: "failed" });
  try {
    const proposal = await fetch(`${context.base}/api/website-builder/projects/${context.session.sessionId}/fix`, { method: "POST", headers: { Cookie: context.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ maxAttempts: 3 }) });
    assert.equal(proposal.status, 200);
    await fetch(`${context.base}/api/website-builder/projects/${context.session.sessionId}/fix/apply`, { method: "POST", headers: { Cookie: context.cookie } });
    await waitFor(() => context.session.repair?.status === "failed");
    assert.equal(context.session.projectFiles[2].content, originalContent);
    assert.equal(context.session.revisions.length, 0);
    assert.equal(context.providerCalls, 2, "a duplicate repair is not rebuilt repeatedly");
    assert.equal(context.runnerRequests.filter((request) => request.method === "POST" && request.pathname === "/v1/sessions").length, 1);
  } finally { context.server.closeAllConnections(); await new Promise((resolve) => context.server.close(resolve)); }
});

test("reverting a reviewed revision rebuilds the previous files and refreshes the runner session", async () => {
  const context = await setup();
  const previousRunnerSessionId = context.session.runnerSessionId;
  context.session.projectFiles[2].content = patchedContent;
  context.session.revisions.push({ revisionId: "revision-to-revert", summary: "Fix syntax", createdAt: new Date(), changes: [{ path: "src/App.jsx", before: originalContent, after: patchedContent }] });
  try {
    const response = await fetch(`${context.base}/api/website-builder/projects/${context.session.sessionId}/revisions/revision-to-revert/revert`, { method: "POST", headers: { Cookie: context.cookie } });
    assert.equal(response.status, 202);
    await waitFor(() => context.session.repair?.status === "preview-updated");
    assert.equal(context.session.projectFiles[2].content, originalContent);
    assert.equal(context.session.revisions.length, 2);
    assert.notEqual(context.session.runnerSessionId, previousRunnerSessionId);
    assert.ok(context.runnerRequests.some((request) => request.method === "DELETE" && request.pathname.endsWith(previousRunnerSessionId)));
  } finally { context.server.closeAllConnections(); await new Promise((resolve) => context.server.close(resolve)); }
});
