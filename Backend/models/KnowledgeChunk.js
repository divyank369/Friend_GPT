import mongoose from "mongoose";

const knowledgeChunkSchema = new mongoose.Schema({
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  sourceId: {
    type: String,
    required: true,
    maxlength: 64
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120
  },
  content: {
    type: String,
    required: true,
    maxlength: 1000
  }
}, { timestamps: true });

// Owner-prefixed text search keeps retrieval scoped to one user's private corpus.
knowledgeChunkSchema.index({ ownerId: 1, title: "text", content: "text" });
knowledgeChunkSchema.index({ ownerId: 1, sourceId: 1 });

export default mongoose.model("KnowledgeChunk", knowledgeChunkSchema);
