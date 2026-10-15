import express from "express";
import mongoose from "mongoose";
import { GridFSBucket, ObjectId } from "mongodb";
import multer from "multer";
import requireAuth from "../middleware/requireAuth.js";
import { detectUploadType, isAllowedUploadMime, supportedUploadTypes } from "../utils/uploadTypes.js";

const router = express.Router();
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, isAllowedUploadMime(file.mimetype, file.originalname))
});

// Reuse MongoDB GridFS so uploaded and generated images stay out of thread documents.
function imageBucket() {
  return new GridFSBucket(mongoose.connection.db, { bucketName: "images" });
}

// Save bytes with ownership metadata; all reads below enforce that owner.
function saveImage(buffer, contentType, filename, ownerId, generated = false) {
  return new Promise((resolve, reject) => {
    const stream = imageBucket().openUploadStream(filename.slice(0, 255), {
      // GridFS stores application-specific MIME metadata in its metadata document.
      metadata: { ownerId: String(ownerId), contentType, generated }
    });
    stream.once("error", reject);
    stream.once("finish", () => resolve(stream.id));
    stream.end(buffer);
  });
}

router.use(requireAuth);

// Return a small, private gallery so generated assets remain discoverable after a refresh.
router.get("/", async (req, res) => {
  try {
    const files = await mongoose.connection.db.collection("images.files")
      .find({ "metadata.ownerId": String(req.user.userId), "metadata.generated": true })
      .sort({ uploadDate: -1 })
      .limit(20)
      .project({ filename: 1, contentType: 1, uploadDate: 1 })
      .toArray();
    return res.json(files.map((file) => ({
      fileId: String(file._id),
      filename: file.filename,
      contentType: file.metadata?.contentType,
      createdAt: file.uploadDate,
      url: `/api/images/${file._id}`
    })));
  } catch (error) {
    console.error("Image gallery error:", error);
    return res.status(500).json({ error: "Could not load generated images" });
  }
});

router.post("/upload", (req, res, next) => {
  upload.single("image")(req, res, (error) => {
    if (error) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ error: status === 413 ? "Files must be 5 MB or smaller" : "Upload one PNG, JPEG, WebP image, or PDF" });
    }
    return next();
  });
}, async (req, res) => {
  const detectedType = req.file ? detectUploadType(req.file.buffer) : null;
  const genericPdfMime = detectedType === "application/pdf" && ["", "application/octet-stream"].includes(req.file?.mimetype);
  if (!req.file || !supportedUploadTypes.has(detectedType) || !isAllowedUploadMime(req.file.mimetype, req.file.originalname) || (req.file.mimetype !== detectedType && !genericPdfMime)) {
    return res.status(400).json({ error: "Upload a valid PNG, JPEG, WebP image, or PDF" });
  }
  try {
    const fileId = await saveImage(req.file.buffer, detectedType, req.file.originalname || "attachment", req.user.userId);
    return res.status(201).json({
      fileId: String(fileId),
      filename: (req.file.originalname || "attachment").slice(0, 255),
      contentType: detectedType,
      url: `/api/images/${fileId}`
    });
  } catch (error) {
    console.error("Image upload error:", error);
    return res.status(500).json({ error: "Could not save image" });
  }
});

// Generate on the server so API credentials never reach browser code.
router.post("/generate", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt || prompt.length > 2000) return res.status(400).json({ error: "Enter an image prompt under 2,000 characters" });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "Image generation is not configured on the server" });

  try {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
        prompt,
        n: 1,
        size: "1024x1024",
        quality: "medium",
        output_format: "png"
      }),
      signal: AbortSignal.timeout(90000)
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || typeof result?.data?.[0]?.b64_json !== "string") {
      console.error("Image generation provider error:", response.status, result?.error?.message || "invalid response");
      if ([400, 404].includes(response.status)) {
        return res.status(502).json({ error: "The configured image model rejected the request. Check OPENAI_IMAGE_MODEL and confirm that the API key has access to it." });
      }
      if ([401, 403].includes(response.status)) {
        return res.status(503).json({ error: "Image generation is not available with the current server API key." });
      }
      if (response.status === 429) {
        return res.status(503).json({ error: "The image provider is busy or its usage limit was reached. Try again later." });
      }
      return res.status(502).json({ error: "Image generation is temporarily unavailable" });
    }
    const bytes = Buffer.from(result.data[0].b64_json, "base64");
    if (bytes.length > 20 * 1024 * 1024 || detectUploadType(bytes) !== "image/png") {
      return res.status(502).json({ error: "Image provider returned an invalid image" });
    }
    const fileId = await saveImage(bytes, "image/png", "generated-image.png", req.user.userId, true);
    return res.status(201).json({ fileId: String(fileId), filename: "generated-image.png", contentType: "image/png", url: `/api/images/${fileId}` });
  } catch (error) {
    console.error("Image generation error:", error);
    const timeout = error.name === "TimeoutError";
    return res.status(timeout ? 504 : 502).json({ error: timeout ? "Image generation took too long" : "Image generation is temporarily unavailable" });
  }
});

// Stream private attachments only after verifying the GridFS record belongs to this session.
router.get("/:fileId", async (req, res) => {
  if (!ObjectId.isValid(req.params.fileId)) return res.status(404).json({ error: "Image not found" });
  const fileId = new ObjectId(req.params.fileId);
  try {
    const file = await mongoose.connection.db.collection("images.files").findOne({ _id: fileId, "metadata.ownerId": String(req.user.userId) });
    const contentType = file?.metadata?.contentType;
    if (!file || !supportedUploadTypes.has(contentType)) return res.status(404).json({ error: "Attachment not found" });
    const headers = {
      "Content-Type": contentType,
      "Content-Length": String(file.length),
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox"
    };
    if (contentType === "application/pdf") {
      const filename = String(file.filename || "attachment.pdf").replace(/[^\w .()-]/g, "_").slice(0, 180) || "attachment.pdf";
      headers["Content-Disposition"] = `attachment; filename="${filename}"`;
    }
    res.set(headers);
    return imageBucket().openDownloadStream(fileId).on("error", (error) => {
      console.error("Image stream error:", error);
      if (!res.headersSent) res.status(500).end();
      else res.destroy(error);
    }).pipe(res);
  } catch (error) {
    console.error("Image read error:", error);
    return res.status(500).json({ error: "Could not load image" });
  }
});

// Let users remove generated or abandoned uploads without exposing another account's files.
router.delete("/:fileId", async (req, res) => {
  if (!ObjectId.isValid(req.params.fileId)) return res.status(404).json({ error: "Image not found" });
  const fileId = new ObjectId(req.params.fileId);
  try {
    const ownedFile = await mongoose.connection.db.collection("images.files").findOne({
      _id: fileId,
      "metadata.ownerId": String(req.user.userId)
    });
    if (!ownedFile) return res.status(404).json({ error: "Image not found" });
    await imageBucket().delete(fileId);
    return res.json({ message: "Image deleted" });
  } catch (error) {
    console.error("Image delete error:", error);
    return res.status(500).json({ error: "Could not delete image" });
  }
});

export default router;
