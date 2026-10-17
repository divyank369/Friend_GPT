 import express from "express";
 import "dotenv/config"; 
 import cors from "cors";
 import cookieParser from "cookie-parser";
 import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
 import chatRoutes from "./routes/chat.js";
 import authRoutes from "./routes/auth.js";
import knowledgeRoutes from "./routes/knowledge.js";
import KnowledgeChunk from "./models/KnowledgeChunk.js";
import Thread from "./models/Thread.js";
import PreviewSession from "./models/PreviewSession.js";
import WebsiteDeployment from "./models/WebsiteDeployment.js";
import imageRoutes from "./routes/images.js";
import websiteBuilderRoutes from "./routes/websiteBuilder.js";
import websiteDeploymentRoutes from "./routes/websiteDeployments.js";
import { createOriginGuard, parseAllowedOrigins } from "./security/originPolicy.js";
import { cleanupExpiredUploads, cleanupOrphanedGridFSChunks } from "./utils/fileLifecycle.js";
import { GridFSBucket } from "mongodb";
import { callSandbox } from "./utils/sandboxService.js";


 const app = express();

 const PORT = process.env.PORT || 8080;
const allowedOrigins = parseAllowedOrigins(process.env.FRONTEND_ORIGIN, process.env.NODE_ENV === "production" ? "" : undefined);

app.set("trust proxy", 1);
app.use((_req, res, next) => {
  // The web app uses CORS for API assets; block cross-site no-CORS embedding.
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  return next();
});
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.includes(origin));
  },
  credentials: true
}));
app.use(createOriginGuard(allowedOrigins));
app.use("/api/website-builder", express.json({ limit: "1mb" }));
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again shortly." }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts. Please try again later." }
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "You are sending messages too quickly. Please try again shortly." }
});
// Image generation has a provider cost, so apply a separate per-IP budget.
const imageGenerationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many image generation requests. Please try again later." }
});
// Cap storage-heavy uploads independently of normal chat traffic.
const imageUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many image uploads. Please try again later." }
});
const previewStartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many preview starts. Please try again later." }
});
const websiteGenerationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many website generation requests. Please try again later." }
});
const websiteRepairLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many repair attempts. Please try again later." }
});
const websiteDeploymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many deployment requests. Please try again later." }
});

app.use("/api", apiLimiter);
app.use("/api/auth", (req, res, next) => {
  const authPath = req.path.replace(/\/+$/, "") || "/";
  if (req.method === "POST" && ["/signup", "/login", "/google"].includes(authPath)) {
    return authLimiter(req, res, next);
  }
  return next();
}, authRoutes);
app.use("/api/chat", chatLimiter);
app.use("/api", chatRoutes);
// Knowledge ingestion is authenticated and uses the regular API request limiter.
app.use("/api/knowledge", knowledgeRoutes);
// Image routes keep uploads, generated assets, and image reads authenticated.
app.use("/api/images/generate", imageGenerationLimiter);
app.use("/api/images/upload", imageUploadLimiter);
app.use("/api/images", imageRoutes);
app.use("/api/website-builder/generate", websiteGenerationLimiter);
app.use("/api/website-builder/projects/:projectId/fix", websiteRepairLimiter);
app.use("/api/website-builder/projects/:projectId/deployments", websiteDeploymentLimiter);
app.use("/api/website-builder/deployments/:deploymentId", websiteDeploymentLimiter);
app.use("/api/website-builder/deployments/:deploymentId/redeploy", websiteDeploymentLimiter);
app.use("/api/website-builder/projects", (req, res, next) => req.method === "POST" ? previewStartLimiter(req, res, next) : next());
app.use("/api/website-builder", websiteBuilderRoutes);
app.use("/api/website-builder", websiteDeploymentRoutes);

app.use((error, _req, res, _next) => {
  const statusCode = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
  const message = statusCode === 413
    ? "Request body is too large"
    : statusCode === 400
      ? "Request body must contain valid JSON"
      : "An unexpected server error occurred";
  if (statusCode === 500) console.error("Unhandled API error", { statusCode });
  return res.status(statusCode).json({ error: message });
});

app.get("/health", (_req, res) => {
  const databaseReady = mongoose.connection.readyState === 1;
  res.status(databaseReady ? 200 : 503).json({
    status: databaseReady ? "ok" : "database-unavailable"
  });
});

const startServer = async () => {
  const requiredEnvironment = ["MONGODB_URI", "AUTH_JWT_SECRET", "GROQ_API_KEY"];
  if (process.env.NODE_ENV === "production") requiredEnvironment.push("FRONTEND_ORIGIN");
  const missingEnvironment = requiredEnvironment.filter((key) => !process.env[key]);
  if (missingEnvironment.length) {
    throw new Error(`Missing required environment variables: ${missingEnvironment.join(", ")}`);
  }
  if (process.env.NODE_ENV === "production" && Buffer.byteLength(process.env.AUTH_JWT_SECRET, "utf8") < 32) {
    throw new Error("AUTH_JWT_SECRET must contain at least 32 bytes");
  }

  await mongoose.connect(process.env.MONGODB_URI);
  // Create indexes used for private knowledge retrieval and attachment reference checks.
  await KnowledgeChunk.createIndexes();
  await Thread.createIndexes();
  await PreviewSession.createIndexes();
  await WebsiteDeployment.createIndexes();
  await mongoose.connection.db.collection("images.files").createIndex({ "metadata.generated": 1, uploadDate: 1 });
  await mongoose.connection.db.collection("images.files").createIndex({ "metadata.pendingExpiresAt": 1 });
  await mongoose.connection.db.collection("images.files").createIndex({ "metadata.cleanupAfter": 1 });
  console.log("Connected to MongoDB");

  const bucket = new GridFSBucket(mongoose.connection.db, { bucketName: "images" });
  const sweepExpiredUploads = async () => {
    try {
      const result = await cleanupExpiredUploads({
        db: mongoose.connection.db,
        bucket,
        ThreadModel: Thread
      });
      const orphanChunks = await cleanupOrphanedGridFSChunks({ db: mongoose.connection.db, bucket });
      if (result.deleted || orphanChunks) {
        console.info("Expired upload cleanup completed", { deleted: result.deleted, orphanChunks });
      }
    } catch (error) {
      console.error("Expired upload cleanup deferred", { name: error.name });
    }
  };
  void sweepExpiredUploads();
  const cleanupTimer = setInterval(sweepExpiredUploads, 60 * 60 * 1000);
  cleanupTimer.unref();

  const cleanupExpiredPreviews = async () => {
    const expired = await PreviewSession.find({ expiresAt: { $lte: new Date() }, status: { $in: ["building", "running"] } }).limit(50);
    for (const session of expired) {
      const sessionIds = [session.runnerSessionId || session.sessionId, session.repair?.candidateSessionId].filter(Boolean);
      await Promise.all(sessionIds.map((sessionId) => callSandbox("DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}`).catch(() => {})));
      session.status = "expired";
      session.previewToken = "revoked";
      if (session.repair) { session.repair.cancelled = true; session.markModified("repair"); }
      await session.save();
    }
  };
  void cleanupExpiredPreviews().catch((error) => console.error("Expired preview cleanup deferred", { name: error.name }));
  const previewCleanupTimer = setInterval(() => {
    void cleanupExpiredPreviews().catch((error) => console.error("Expired preview cleanup deferred", { name: error.name }));
  }, 60 * 1000);
  previewCleanupTimer.unref();

  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
};

startServer().catch((error) => {
  console.error("Server startup failed", { name: error.name });
  process.exit(1);
});

