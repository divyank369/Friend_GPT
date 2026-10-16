import { randomUUID } from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import KnowledgeChunk from "../models/KnowledgeChunk.js";
import requireAuth from "../middleware/requireAuth.js";
import { ownerScopedQuery } from "../security/ownerQuery.js";

const router = express.Router();
const MAX_SOURCE_CHARACTERS = 30000;
const MAX_SOURCES_PER_USER = 20;
const CHUNK_CHARACTERS = 800;
const CHUNK_OVERLAP = 120;

// Split at word boundaries and retain overlap so retrieved chunks preserve context.
function splitIntoChunks(text) {
  const normalizedText = text.replace(/\0/g, "").replace(/\r\n?/g, "\n").trim();
  const chunks = [];
  let cursor = 0;

  while (cursor < normalizedText.length) {
    let end = Math.min(cursor + CHUNK_CHARACTERS, normalizedText.length);
    if (end < normalizedText.length) {
      const wordBoundary = normalizedText.lastIndexOf(" ", end);
      if (wordBoundary > cursor + CHUNK_CHARACTERS / 2) end = wordBoundary;
    }
    const content = normalizedText.slice(cursor, end).trim();
    if (content) chunks.push({ content });
    if (end >= normalizedText.length) break;
    cursor = Math.max(end - CHUNK_OVERLAP, cursor + 1);
  }

  return chunks;
}

router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    // Group chunk rows into source summaries without returning private document text.
    const sources = await KnowledgeChunk.aggregate([
      { $match: ownerScopedQuery(new mongoose.Types.ObjectId(req.user.userId)) },
      {
        $group: {
          _id: "$sourceId",
          title: { $first: "$title" },
          chunkCount: { $sum: 1 },
          createdAt: { $min: "$createdAt" }
        }
      },
      { $sort: { createdAt: -1 } },
      { $limit: MAX_SOURCES_PER_USER }
    ]);
    return res.json(sources.map(({ _id, ...source }) => ({ sourceId: _id, ...source })));
  } catch (error) {
    console.error("Knowledge list failed", { name: error.name });
    return res.status(500).json({ error: "Could not fetch knowledge sources" });
  }
});

router.post("/", async (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const content = typeof req.body?.content === "string" ? req.body.content : "";
  if (!title || title.length > 120 || !content.trim() || content.length > MAX_SOURCE_CHARACTERS) {
    return res.status(400).json({ error: "Provide a title and text under 30,000 characters" });
  }

  try {
    // Enforce a small per-user source cap before chunking to bound storage and search cost.
    const existingSources = await KnowledgeChunk.distinct("sourceId", ownerScopedQuery(req.user.userId));
    if (existingSources.length >= MAX_SOURCES_PER_USER) {
      return res.status(409).json({ error: "Knowledge source limit reached" });
    }

    const chunks = splitIntoChunks(content);
    if (!chunks.length) return res.status(400).json({ error: "The source does not contain readable text" });
    const sourceId = randomUUID();
    const documents = chunks.map(({ content: chunkContent }) => ({
      ...ownerScopedQuery(req.user.userId),
      sourceId,
      title,
      content: chunkContent
    }));
    await KnowledgeChunk.insertMany(documents, { ordered: true });
    return res.status(201).json({ sourceId, title, chunkCount: chunks.length });
  } catch (error) {
    console.error("Knowledge save failed", { name: error.name });
    return res.status(500).json({ error: "Could not save knowledge source" });
  }
});

router.delete("/:sourceId", async (req, res) => {
  try {
    // Match both owner and source ID so users cannot delete another account's knowledge.
    const result = await KnowledgeChunk.deleteMany({
      ...ownerScopedQuery(req.user.userId, { sourceId: req.params.sourceId })
    });
    if (!result.deletedCount) return res.status(404).json({ error: "Knowledge source not found" });
    return res.json({ message: "Knowledge source deleted" });
  } catch (error) {
    console.error("Knowledge delete failed", { name: error.name });
    return res.status(500).json({ error: "Could not delete knowledge source" });
  }
});

export default router;
