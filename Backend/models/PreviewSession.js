import mongoose from "mongoose";

const previewSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  status: { type: String, enum: ["building", "running", "failed", "stopped", "expired"], required: true },
  previewToken: { type: String, required: true, select: false },
  runnerSessionId: { type: String, default: "" },
  deploymentProjectName: { type: String, default: "" },
  deploymentLock: { type: Boolean, default: false },
  projectName: { type: String, default: "Generated website" },
  projectFiles: { type: [new mongoose.Schema({ path: String, content: String }, { _id: false })], default: [] },
  revisions: { type: [new mongoose.Schema({
    revisionId: { type: String, required: true },
    summary: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    changes: { type: [new mongoose.Schema({ path: String, before: String, after: String }, { _id: false })], default: [] }
  }, { _id: false })], default: [] },
  repair: { type: mongoose.Schema.Types.Mixed, default: null },
  error: { type: String, default: "" },
  expiresAt: { type: Date, required: true, index: true },
  lastAccessedAt: { type: Date, required: true, default: Date.now }
}, { timestamps: true });

previewSessionSchema.index({ ownerId: 1, createdAt: -1 });
previewSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.PreviewSession || mongoose.model("PreviewSession", previewSessionSchema);
