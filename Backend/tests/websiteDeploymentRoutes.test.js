import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, mock, test } from "node:test";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { createServer } from "node:http";
import websiteDeploymentRoutes from "../routes/websiteDeployments.js";
import PreviewSession from "../models/PreviewSession.js";
import WebsiteDeployment from "../models/WebsiteDeployment.js";
import User from "../models/User.js";

const oldEnv = Object.fromEntries(["AUTH_JWT_SECRET", "SANDBOX_SERVICE_URL", "SANDBOX_SERVICE_TOKEN", "SANDBOX_PREVIEW_BASE_URL", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "NODE_ENV"].map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const ownerId = "507f1f77bcf86cd799439011";
const otherId = "507f1f77bcf86cd799439012";
const secret = "website-deployment-test-secret-long-enough";
const projectId = "b7614d5b-9923-4be0-9d23-a4539b78c8f9";
const session = { sessionId: projectId, ownerId, status: "running", runnerSessionId: projectId, projectName: "Portfolio", projectType: "react-vite", deploymentLock: false, deploymentProjectName: "", expiresAt: new Date(Date.now() + 60000), projectFiles: [
  { path: "index.html", content: "<div id='root'></div>" },
  { path: "package.json", content: JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", vite: "^6.0.0" } }) }
], repair: null, async save() {} };
let records;
let holdBuild;
let userLockUntil = null;
let ownerLockReleases = 0;
let providerStageStatus = "success";

function response(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }); }

async function setup({ configured = true, failBuild = false, stageStatus = "success", dailyCount = 0, publishedProjectCount = 0 } = {}) {
  process.env.AUTH_JWT_SECRET = secret;
  process.env.SANDBOX_SERVICE_URL = "https://runner.internal";
  process.env.SANDBOX_SERVICE_TOKEN = "a-sandbox-token-that-is-long-enough";
  process.env.SANDBOX_PREVIEW_BASE_URL = "https://preview.example.test";
  process.env.NODE_ENV = "test";
  if (configured) {
    process.env.CLOUDFLARE_ACCOUNT_ID = "a".repeat(32);
    process.env.CLOUDFLARE_API_TOKEN = "cloudflare-pages-write-token-long-enough";
  } else { delete process.env.CLOUDFLARE_ACCOUNT_ID; delete process.env.CLOUDFLARE_API_TOKEN; }
  session.deploymentLock = false; session.deploymentProjectName = ""; session.status = "running";
  userLockUntil = null;
  ownerLockReleases = 0;
  providerStageStatus = stageStatus;
  mock.method(User, "findOneAndUpdate", async (_query, update) => {
    if (userLockUntil && userLockUntil > new Date()) return null;
    userLockUntil = update.$set.websiteDeploymentLockUntil;
    return { _id: ownerId };
  });
  mock.method(User, "updateOne", async (_query, update) => { ownerLockReleases += 1; if (Object.hasOwn(update.$unset || {}, "websiteDeploymentLockUntil")) userLockUntil = null; return { modifiedCount: 1 }; });
  records = [];
  holdBuild = null;
  mock.method(PreviewSession, "findOne", async (query) => query.ownerId === ownerId && query.sessionId === projectId ? session : null);
  mock.method(PreviewSession, "findOneAndUpdate", async (query) => {
    if (query.ownerId !== ownerId || session.deploymentLock) return null;
    session.deploymentLock = true;
    return session;
  });
  mock.method(WebsiteDeployment, "countDocuments", async () => dailyCount);
  mock.method(WebsiteDeployment, "distinct", async () => Array.from({ length: publishedProjectCount }, (_, index) => `old-project-${index}`));
  mock.method(WebsiteDeployment, "create", async (data) => {
    const record = { ...data, createdAt: new Date(), updatedAt: new Date(), async save() { this.updatedAt = new Date(); } };
    records.push(record);
    return record;
  });
  mock.method(WebsiteDeployment, "findOne", async (query) => records.find((item) => item.deploymentId === query.deploymentId && query.ownerId === ownerId) || null);
  mock.method(WebsiteDeployment, "find", () => ({ sort() { return this; }, limit() { return this; }, lean: async () => records.filter((item) => item.ownerId === ownerId).map((item) => ({ ...item })) }));
  const htmlBytes = Buffer.from("<main>Published</main>");
  const html = { path: "index.html", content: htmlBytes.toString("base64"), contentType: "text/html", hash: createHash("sha256").update(htmlBytes).digest("hex") };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith("https://runner.internal/")) {
      const pathname = new URL(target).pathname;
      if (pathname.endsWith("/build")) {
        if (holdBuild) await holdBuild;
        return failBuild ? response({ error: "The production build failed. Review the project code and preview before trying again." }, 422) : response({ files: [html] });
      }
      return response({ status: "running" });
    }
    if (target.startsWith("https://api.cloudflare.com/client/v4/")) {
      const pathname = new URL(target).pathname;
      if (/\/pages\/projects\/sg-[a-f0-9]+$/.test(pathname) && options.method !== "POST") return response({ success: true, result: { name: pathname.split("/").pop() } });
      if (pathname.endsWith("/upload-token")) return response({ success: true, result: { jwt: "short-lived-upload-jwt-for-test" } });
      if (pathname.endsWith("/assets/check-missing")) return response({ success: true, result: [html.hash] });
      if (pathname.endsWith("/assets/upload")) return response({ success: true });
      if (pathname.endsWith("/deployments") && options.method === "POST") return response({ success: true, result: { id: "d81a0ba9-3d89-4b40-9fa1-acdeedaa1122", url: "https://preview.sg-test.pages.dev", aliases: ["https://sg-test.pages.dev"], latest_stage: { status: providerStageStatus } } });
      if (pathname.includes("/deployments/") && options.method === "DELETE") return response({ success: true, result: { id: pathname.split("/").pop() } });
      if (pathname.includes("/deployments/")) return response({ success: true, result: { id: pathname.split("/").pop(), url: "https://preview.sg-test.pages.dev", aliases: ["https://sg-test.pages.dev"], latest_stage: { status: providerStageStatus } } });
    }
    throw new Error(`Unexpected fetch ${target}`);
  };
  const app = express(); app.use(express.json()); app.use(cookieParser()); app.use("/api/website-builder", websiteDeploymentRoutes);
  const server = createServer(app); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cookie = (id = ownerId) => `friendgpt_session=${jwt.sign({ sub: id }, secret, { algorithm: "HS256", expiresIn: "1h" })}`;
  return { baseUrl, cookie, request: (...args) => originalFetch(...args), close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

afterEach(() => {
  mock.restoreAll(); globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test("publishing requires auth, ownership, explicit confirmation, configured provider, and a running preview", async () => {
  const context = await setup();
  try {
    const url = `${context.baseUrl}/api/website-builder/projects/${projectId}/deployments`;
    assert.equal((await context.request(url, { method: "POST" })).status, 401);
    assert.equal((await context.request(`${context.baseUrl}/api/website-builder/projects/other/deployments`, { method: "POST", headers: { Cookie: context.cookie(), "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) })).status, 404);
    assert.equal((await context.request(url, { method: "POST", headers: { Cookie: context.cookie(), "Content-Type": "application/json" }, body: JSON.stringify({}) })).status, 400);
    const wrongOwner = await context.request(url, { method: "POST", headers: { Cookie: context.cookie(otherId), "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
    assert.equal(wrongOwner.status, 404);
  } finally { await context.close(); }
});

test("creates, inspects, lists, and redeploys an owned revision after an isolated build", async () => {
  const context = await setup();
  try {
    const url = `${context.baseUrl}/api/website-builder/projects/${projectId}/deployments`;
    const created = await context.request(url, { method: "POST", headers: { Cookie: context.cookie(), "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
    assert.equal(created.status, 202);
    const deployment = await created.json();
    for (let i = 0; i < 20 && records[0]?.status !== "success"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(records[0].status, "success");
    assert.equal(records[0].publicUrl, "https://sg-test.pages.dev");
    assert.equal((await context.request(`${context.baseUrl}/api/website-builder/deployments/${deployment.deploymentId}`, { headers: { Cookie: context.cookie() } })).status, 200);
    assert.equal((await context.request(`${context.baseUrl}/api/website-builder/deployments?projectId=${projectId}`, { headers: { Cookie: context.cookie() } })).status, 200);
    const deleted = await context.request(`${context.baseUrl}/api/website-builder/deployments/${deployment.deploymentId}`, { method: "DELETE", headers: { Cookie: context.cookie() } });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).status, "deleted");
    for (let i = 0; i < 20 && userLockUntil; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(userLockUntil, null, `owner lock releases=${ownerLockReleases}`);
    const redeploy = await context.request(`${context.baseUrl}/api/website-builder/deployments/${deployment.deploymentId}/redeploy`, { method: "POST", headers: { Cookie: context.cookie(), "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
    assert.equal(redeploy.status, 202, JSON.stringify(await redeploy.json()));
    for (let i = 0; i < 20 && records[1]?.status !== "success"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(records.length, 2);
    assert.equal(records[1].providerProjectName, records[0].providerProjectName);
    assert.equal(records[1].projectRevision, records[0].projectRevision);
  } finally { await context.close(); }
});

test("provider configuration, failed build, duplicate request, ownership and history are safely handled", async () => {
  const unconfigured = await setup({ configured: false });
  try {
    const response = await unconfigured.request(`${unconfigured.baseUrl}/api/website-builder/projects/${projectId}/deployments`, { method: "POST", headers: { Cookie: unconfigured.cookie(), "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
    assert.equal(response.status, 503);
  } finally { await unconfigured.close(); }

  const failed = await setup({ failBuild: true });
  try {
    const url = `${failed.baseUrl}/api/website-builder/projects/${projectId}/deployments`;
    const response = await failed.request(url, { method: "POST", headers: { Cookie: failed.cookie(), "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
    assert.equal(response.status, 202);
    for (let i = 0; i < 20 && records[0]?.status !== "failed"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(records[0].status, "failed");
    assert.match(records[0].error, /production build failed/i);
    assert.equal(session.deploymentLock, false);
  } finally { await failed.close(); }

  const duplicate = await setup();
  try {
    holdBuild = new Promise((resolve) => setTimeout(resolve, 100));
    const url = `${duplicate.baseUrl}/api/website-builder/projects/${projectId}/deployments`;
    const send = () => duplicate.request(url, { method: "POST", headers: { Cookie: duplicate.cookie(), "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
    assert.equal((await send()).status, 202);
    assert.equal((await send()).status, 409);
    for (let i = 0; i < 40 && records[0]?.status !== "success"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  } finally { await duplicate.close(); }
});

test("provider active stages stay in progress and per-account quotas are enforced", async () => {
  const active = await setup({ stageStatus: "active" });
  try {
    const url = `${active.baseUrl}/api/website-builder/projects/${projectId}/deployments`;
    const created = await active.request(url, { method: "POST", headers: { Cookie: active.cookie(), "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
    const deployment = await created.json();
    for (let i = 0; i < 20 && records[0]?.status !== "deploying"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const status = await active.request(`${active.baseUrl}/api/website-builder/deployments/${deployment.deploymentId}`, { headers: { Cookie: active.cookie() } });
    assert.equal((await status.json()).status, "deploying", "an active provider stage is not reported as successful");
    for (let i = 0; i < 20 && userLockUntil; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  } finally { await active.close(); }

  const dailyQuota = await setup({ dailyCount: 5 });
  try {
    const response = await dailyQuota.request(`${dailyQuota.baseUrl}/api/website-builder/projects/${projectId}/deployments`, { method: "POST", headers: { Cookie: dailyQuota.cookie(), "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
    assert.equal(response.status, 429);
  } finally { await dailyQuota.close(); }

  const siteQuota = await setup({ publishedProjectCount: 3 });
  try {
    const response = await siteQuota.request(`${siteQuota.baseUrl}/api/website-builder/projects/${projectId}/deployments`, { method: "POST", headers: { Cookie: siteQuota.cookie(), "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
    assert.equal(response.status, 429);
  } finally { await siteQuota.close(); }
});
