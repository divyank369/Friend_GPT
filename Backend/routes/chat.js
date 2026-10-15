import express from "express";
import Thread from "../models/Thread.js"; 
import { runAssistant } from "../ai/assistantGraph.js";
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
            // Bound response size even for legacy threads created before retention limits.
            const thread = await Thread.findOne({ threadId, ownerId: req.user.userId })
              .select({ messages: { $slice: -100 } });
            if(!thread){
                // Keep API errors consistently machine-readable for frontend clients.
                return res.status(404).json({ error: "Thread not found" });
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
                // Keep API errors consistently machine-readable for frontend clients.
                return res.status(404).json({ error: "Thread not found" });
            }
            return res.json({ message: "Conversation deleted" });
        }catch(err){
            console.error("Thread delete error:", err);
            return res.status(500).json({ error: "Could not delete conversation" });
        }

    });

router.post("/chat", async (req, res) => {
  const { threadId: suppliedThreadId, message } = req.body || {};
  // Normalize IDs once so validation and database lookups use the same value.
  const threadId = typeof suppliedThreadId === "string" ? suppliedThreadId.trim() : suppliedThreadId;

  if (
    typeof threadId !== "string" || !threadId.trim() || threadId.length > 128 ||
    typeof message !== "string" || !message.trim() || message.length > 8000
  ) {
    return res.status(400).json({ error: "Provide a valid conversation ID and a message under 8,000 characters" });
  }

  const generationController = new AbortController();
  req.once("aborted", () => generationController.abort());
  res.once("close", () => {
    if (!res.writableEnded) generationController.abort();
  });

  try {
    // Load only the retained tail so old unbounded records cannot inflate memory use.
    let thread = await Thread.findOne({ threadId, ownerId: req.user.userId })
      .select({ messages: { $slice: -100 } });

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
    // Keep only complete, recent turns within the context budget; cutting the
    // beginning of an old message can otherwise leave the model misleading text.
    for (const entry of conversation.slice(-20).reverse()) {
      if (remainingCharacters <= 0) break;
      if (entry.content.length > remainingCharacters) break;
      modelMessages.unshift({ role: entry.role, content: entry.content });
      remainingCharacters -= entry.content.length;
    }

    let streamStarted = false;
    const assistantReply = await runAssistant({
      userId: req.user.userId,
      messages: modelMessages,
      onToken: (token) => {
      if (res.destroyed || generationController.signal.aborted) return;
      if (!streamStarted) {
        streamStarted = true;
        res.status(200).set({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        res.flushHeaders();
      }
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
      },
      signal: generationController.signal
    });

    if (typeof assistantReply !== "string" || !assistantReply.trim()) {
      return res.status(502).json({ error: "AI provider returned an empty response" });
    }
    if (generationController.signal.aborted || res.destroyed) return;

    // Use an atomic append instead of saving the stale document loaded before
    // generation; overlapping requests must not replace each other's messages.
    const exchange = [
      { role: "user", content: message.trim() },
      { role: "assistant", content: assistantReply }
    ];
    const updatedAt = new Date();
    if (thread.isNew) {
      thread.messages = exchange;
      thread.updatedAt = updatedAt;
      try {
        await thread.save();
      } catch (saveError) {
        // Two tabs can create the same new thread concurrently; recover the
        // unique-key race by atomically appending to the thread that won.
        if (saveError.code !== 11000) throw saveError;
        const savedThread = await Thread.findOneAndUpdate(
          { threadId, ownerId: req.user.userId },
          {
            $push: { messages: { $each: exchange, $slice: -100 } },
            $set: { updatedAt }
          },
          { new: true, runValidators: true }
        );
        if (!savedThread) {
          res.write(`event: error\ndata: ${JSON.stringify({ message: "Thread not found" })}\n\n`);
          return res.end();
        }
      }
    } else {
      const savedThread = await Thread.findOneAndUpdate(
        { _id: thread._id, ownerId: req.user.userId },
        {
          $push: { messages: { $each: exchange, $slice: -100 } },
          $set: { updatedAt }
        },
        { new: true, runValidators: true }
      );
      if (!savedThread) {
        // Tokens may already be on the wire, so report late persistence errors
        // as SSE events instead of trying to change the HTTP status afterward.
        res.write(`event: error\ndata: ${JSON.stringify({ message: "Thread not found" })}\n\n`);
        return res.end();
      }
    }

    res.write("event: done\ndata: {}\n\n");
    return res.end();
  } catch (err) {
    if (generationController.signal.aborted || res.destroyed || req.aborted) return;
    console.error("Chat error:", err);
    const statusCode = err.statusCode || 500;
    const errorMessage = err.statusCode ? err.message : "Could not process your message";
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: errorMessage })}\n\n`);
      return res.end();
    }
    return res.status(statusCode).json({ error: errorMessage });
  }
});

export default router;
