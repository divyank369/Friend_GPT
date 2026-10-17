import mongoose from "mongoose";

const websiteDeploymentSchema = new mongoose.Schema({
  deploymentId: { type: String, required: true, unique: true },
  projectId: { type: String, required: true, index: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  projectRevision: { type: String, required: true },
  provider: { type: String, enum: ["cloudflare-pages"], required: true },
  providerProjectName: { type: String, required: true },
  providerDeploymentId: { type: String, default: "" },
  publicUrl: { type: String, default: "" },
  status: { type: String, enum: ["building", "deploying", "success", "failed", "deleted"], required: true, index: true },
  error: { type: String, default: "" }
}, { timestamps: true });

websiteDeploymentSchema.index({ ownerId: 1, projectId: 1, createdAt: -1 });
export default mongoose.models.WebsiteDeployment || mongoose.model("WebsiteDeployment", websiteDeploymentSchema);
