import express from "express";
import { randomUUID } from "node:crypto";
import requireAuth from "../middleware/requireAuth.js";
import PreviewSession from "../models/PreviewSession.js";
import WebsiteDeployment from "../models/WebsiteDeployment.js";
import User from "../models/User.js";
import { callSandbox } from "../utils/sandboxService.js";
import { validateReactPreviewProject } from "../utils/websiteProject.js";
import { projectRevision, validateDeploymentAssets } from "../utils/deploymentValidation.js";
import { createCloudflarePagesAdapter } from "../utils/providers/cloudflarePages.js";

const router = express.Router();
router.use(requireAuth);
const ONE_DAY = 24 * 60 * 60 * 1000;
const MAX_DAILY_DEPLOYS = 5;
const MAX_PUBLISHED_PROJECTS = 3;
const OWNER_DEPLOY_LOCK_MS = 15 * 60 * 1000;

async function releaseOwnerLock(ownerId, lockUntil) {
  await User.updateOne({ _id: ownerId, websiteDeploymentLockUntil: lockUntil }, { $unset: { websiteDeploymentLockUntil: "" } }).catch(() => {});
}

function publicDeployment(deployment) {
  return {
    deploymentId: deployment.deploymentId,
    projectId: deployment.projectId,
    projectRevision: deployment.projectRevision,
    provider: deployment.provider,
    status: deployment.status,
    ...(deployment.publicUrl ? { publicUrl: deployment.publicUrl } : {}),
    ...(deployment.error ? { error: deployment.error } : {}),
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt
  };
}

function statusFromProvider(status) {
  const normalized = String(status || "").toLowerCase();
  if (["success", "ready"].includes(normalized)) return "success";
  if (["failure", "failed", "canceled", "cancelled"].includes(normalized)) return "failed";
  return "deploying";
}

async function runDeployment(deployment, session, adapter, ownerLockUntil) {
  try {
    deployment.status = "building";
    await deployment.save();
    const build = await callSandbox("POST", `/v1/sessions/${encodeURIComponent(session.runnerSessionId || session.sessionId)}/build`, undefined, { timeoutMs: 120_000 });
    const files = validateDeploymentAssets(build?.files);
    deployment.status = "deploying";
    await deployment.save();
    const result = await adapter.deploy(deployment.providerProjectName, files);
    deployment.providerDeploymentId = result.id;
    deployment.publicUrl = result.publicUrl;
    deployment.status = statusFromProvider(result.status);
    if (deployment.status === "failed") deployment.error = "The hosting provider reported that the deployment failed.";
    await deployment.save();
  } catch (error) {
    deployment.status = "failed";
    deployment.error = error.statusCode === 503 || error.statusCode === 429 || error.statusCode === 422
      ? error.message
      : "The build or hosting provider request failed. Check the project and try again.";
    await deployment.save().catch(() => {});
  } finally {
    session.deploymentLock = false;
    await session.save().catch(() => {});
    await releaseOwnerLock(deployment.ownerId, ownerLockUntil);
  }
}

async function startDeployment(session, ownerId, adapter, res) {
  if (!session || session.ownerId.toString() !== ownerId.toString()) return res.status(404).json({ error: "Preview project not found." });
  if (session.expiresAt <= new Date()) return res.status(410).json({ error: "This preview session expired. Run the project again before publishing." });
  if (session.status !== "running" || session.repair && !["failed", "preview-updated", "cancelled"].includes(session.repair.status)) return res.status(409).json({ error: "A successful live preview with no repair in progress is required before publishing." });
  let project;
  try { project = validateReactPreviewProject({ projectType: "react-vite", name: session.projectName, files: session.projectFiles }); }
  catch (error) { return res.status(400).json({ error: error.message || "This project cannot be published." }); }
  try {
    const remote = await callSandbox("GET", `/v1/sessions/${encodeURIComponent(session.runnerSessionId || session.sessionId)}`);
    if (remote.status !== "running") return res.status(409).json({ error: "The live preview is no longer running. Run the project again before publishing." });
  } catch { return res.status(503).json({ error: "Could not verify the isolated preview before publishing." }); }

  const ownerLockUntil = new Date(Date.now() + OWNER_DEPLOY_LOCK_MS);
  const lockedOwner = await User.findOneAndUpdate(
    { _id: ownerId, $or: [{ websiteDeploymentLockUntil: null }, { websiteDeploymentLockUntil: { $exists: false } }, { websiteDeploymentLockUntil: { $lte: new Date() } }] },
    { $set: { websiteDeploymentLockUntil: ownerLockUntil } }, { new: true }
  );
  if (!lockedOwner) return res.status(409).json({ error: "Another deployment for your account is already in progress." });
  let lockHandedOff = false;
  try {
    const since = new Date(Date.now() - ONE_DAY);
    const dailyCount = await WebsiteDeployment.countDocuments({ ownerId, createdAt: { $gte: since } });
    if (dailyCount >= MAX_DAILY_DEPLOYS) return res.status(429).json({ error: "You have reached the deployment limit. Try again later." });
    const publishedProjects = await WebsiteDeployment.distinct("projectId", { ownerId, status: "success" });
    if (!publishedProjects.includes(session.sessionId) && publishedProjects.length >= MAX_PUBLISHED_PROJECTS) return res.status(429).json({ error: "You have reached the published website limit." });
    const lockedSession = await PreviewSession.findOneAndUpdate(
      { sessionId: session.sessionId, ownerId, deploymentLock: { $ne: true } },
      { $set: { deploymentLock: true } }, { new: true }
    );
    if (!lockedSession) return res.status(409).json({ error: "A deployment for this project is already in progress." });
    session = lockedSession;
    const providerProjectName = session.deploymentProjectName || adapter.projectName(session.sessionId);
    session.deploymentProjectName = providerProjectName;
    await session.save();
    const deployment = await WebsiteDeployment.create({
      deploymentId: randomUUID(), projectId: session.sessionId, ownerId, projectRevision: projectRevision(project.files),
      provider: adapter.name, providerProjectName, status: "building"
    });
    lockHandedOff = true;
    void runDeployment(deployment, session, adapter, ownerLockUntil);
    return res.status(202).json(publicDeployment(deployment));
  } catch (error) {
    session.deploymentLock = false;
    await session.save().catch(() => {});
    throw error;
  } finally {
    if (!lockHandedOff) await releaseOwnerLock(ownerId, ownerLockUntil);
  }
}

router.get("/deployments", async (req, res) => {
  const query = { ownerId: req.user.userId };
  if (typeof req.query.projectId === "string") query.projectId = req.query.projectId;
  const deployments = await WebsiteDeployment.find(query).sort({ createdAt: -1 }).limit(50).lean();
  return res.json({ deployments: deployments.map(publicDeployment) });
});

router.post("/projects/:projectId/deployments", async (req, res) => {
  if (req.body?.confirmed !== true) return res.status(400).json({ error: "Confirm that you want to publish this website publicly." });
  let adapter;
  try { adapter = createCloudflarePagesAdapter(); }
  catch (error) { return res.status(error.statusCode || 503).json({ error: error.message || "Website publishing is not configured." }); }
  const session = await PreviewSession.findOne({ sessionId: req.params.projectId, ownerId: req.user.userId });
  return startDeployment(session, req.user.userId, adapter, res);
});

router.post("/deployments/:deploymentId/redeploy", async (req, res) => {
  if (req.body?.confirmed !== true) return res.status(400).json({ error: "Confirm that you want to publish this newer revision." });
  const prior = await WebsiteDeployment.findOne({ deploymentId: req.params.deploymentId, ownerId: req.user.userId });
  if (!prior) return res.status(404).json({ error: "Deployment not found." });
  let adapter;
  try { adapter = createCloudflarePagesAdapter(); }
  catch (error) { return res.status(error.statusCode || 503).json({ error: error.message || "Website publishing is not configured." }); }
  const session = await PreviewSession.findOne({ sessionId: prior.projectId, ownerId: req.user.userId });
  return startDeployment(session, req.user.userId, adapter, res);
});

router.get("/deployments/:deploymentId", async (req, res) => {
  const deployment = await WebsiteDeployment.findOne({ deploymentId: req.params.deploymentId, ownerId: req.user.userId });
  if (!deployment) return res.status(404).json({ error: "Deployment not found." });
  if (deployment.status === "deploying" && deployment.providerDeploymentId) {
    try {
      const adapter = createCloudflarePagesAdapter();
      const state = await adapter.status(deployment.providerProjectName, deployment.providerDeploymentId);
      deployment.status = statusFromProvider(state.status);
      if (state.publicUrl) deployment.publicUrl = state.publicUrl;
      if (deployment.status === "failed") deployment.error = "The hosting provider reported that the deployment failed.";
      await deployment.save();
    } catch { /* Keep the last known provider status when its API is unavailable. */ }
  }
  return res.json(publicDeployment(deployment));
});

router.delete("/deployments/:deploymentId", async (req, res) => {
  const deployment = await WebsiteDeployment.findOne({ deploymentId: req.params.deploymentId, ownerId: req.user.userId });
  if (!deployment) return res.status(404).json({ error: "Deployment not found." });
  if (deployment.status !== "success" || !deployment.providerDeploymentId) return res.status(409).json({ error: "Only a completed deployment can be deleted." });
  let adapter;
  try { adapter = createCloudflarePagesAdapter(); }
  catch (error) { return res.status(error.statusCode || 503).json({ error: error.message || "Website publishing is not configured." }); }
  try {
    await adapter.deleteDeployment(deployment.providerProjectName, deployment.providerDeploymentId);
    deployment.status = "deleted";
    deployment.publicUrl = "";
    await deployment.save();
    return res.json(publicDeployment(deployment));
  } catch {
    return res.status(502).json({ error: "The hosting provider could not delete this deployment. The current live deployment may not be removable." });
  }
});

export default router;
