import express from "express";
import Thread from "../models/Thread.js"; 
import getGroqResponse from "../utils/openai.js";
import requireAuth from "../middleware/requireAuth.js";

const router = express.Router();
router.use(requireAuth);

    router.get("/thread", async (req, res) => {
        try{
      const threads = await Thread.find({ ownerId: req.user.userId })
        .select("threadId title updatedAt")
        .sort({ updatedAt: -1 });
      return res.json(threads);
        }catch(err){
      console.error("Thread list error:", err);
      return res.status(500).json({ error: "Could not fetch conversations" });
        }
    });
    router.get("/thread/:threadId", async (req, res) => {
        try{
            const {threadId} = req.params;
            const thread = await Thread.findOne({ threadId, ownerId: req.user.userId });
            if(!thread){
                return res.status(404).json("Thread not found");
            }
            return res.json(thread.messages);
        }catch(err){
            console.error("Thread fetch error:", err);
            return res.status(500).json({ error: "Could not fetch conversation" });
        }
    });
    router.delete("/thread/:threadId", async (req, res) => {
        try{
            const {threadId} = req.params;
            const thread = await Thread.findOneAndDelete({ threadId, ownerId: req.user.userId });
            if(!thread){
                return res.status(404).json("Thread not found");
            }
            return res.json({ message: "Conversation deleted" });
        }catch(err){
            console.error("Thread delete error:", err);
            return res.status(500).json({ error: "Could not delete conversation" });
        }

    });

router.post("/chat", async (req, res) => {
  const { threadId, message } = req.body || {};

  if (
    typeof threadId !== "string" || !threadId.trim() || threadId.length > 128 ||
    typeof message !== "string" || !message.trim() || message.length > 8000
  ) {
    return res.status(400).json({ error: "Provide a valid conversation ID and a message under 8,000 characters" });
  }

  try {
    let thread = await Thread.findOne({ threadId, ownerId: req.user.userId });

    if (!thread) {
      if (await Thread.exists({ threadId })) {
        return res.status(404).json({ error: "Thread not found" });
      }
      thread = new Thread({
        ownerId: req.user.userId,
        threadId,
        title: message.trim().replace(/\s+/g, " ").slice(0, 120)
      });
    }

    const modelMessages = [];
    let remainingCharacters = 24000;
    const conversation = [...(thread.messages || []), { role: "user", content: message.trim() }];
    for (const entry of conversation.slice(-20).reverse()) {
      if (remainingCharacters <= 0) break;
      const content = entry.content.slice(-remainingCharacters);
      modelMessages.unshift({ role: entry.role, content });
      remainingCharacters -= content.length;
    }

    const assistantReply = await getGroqResponse(modelMessages);

    if (typeof assistantReply !== "string" || !assistantReply.trim()) {
      return res.status(502).json({ error: "AI provider returned an empty response" });
    }

    thread.messages.push({ role: "user", content: message.trim() });
    thread.messages.push({ role: "assistant", content: assistantReply });
    thread.updatedAt = new Date();
    await thread.save();

    return res.json({ reply: assistantReply });
  } catch (err) {
    console.error("Chat error:", err);
    return res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Could not process your message"
    });
  }
});

export default router;