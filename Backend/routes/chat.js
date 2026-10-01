import express from "express";
import Thread from "../models/Thread.js"; 
import getOpenAIResponse from "../utils/openai.js"; 
import requireAuth from "../middleware/requireAuth.js";

const  router = express.Router();
router.use(requireAuth);

router.post("/test", async (req, res) => {
        try{
            const thread = new Thread({
            ownerId: req.user.userId,
                threadId: "xyz5",
                title: "new thread bbn creeeeeation from code ",
            });
           const response = await thread.save();
           res.send(response);
        }catch(err){
            console.error(err);
            res.status(500).json("Error creating thread");
        }
    })

    router.get("/thread", async (req, res) => {
        try{
            const threads = await Thread.find({ ownerId: req.user.userId }).sort({ updatedAt: -1 });


            // we want threads in the descending order of updatedAt
            res.json(threads);
        }catch(err){
            console.error(err);
            res.status(500).json("Error fetching threads");
        }
    });
    router.get("/thread/:threadId", async (req, res) => {
        try{
            const {threadId} = req.params;
            const thread = await Thread.findOne({ threadId, ownerId: req.user.userId });
            if(!thread){
                return res.status(404).json("Thread not found");
            }
            res.json(thread.messages);
        }catch(err){
            console.error(err);
            res.status(500).json("Error fetching thread");
        }
    });
    router.delete("/thread/:threadId", async (req, res) => {
        try{
            const {threadId} = req.params;
            const thread = await Thread.findOneAndDelete({ threadId, ownerId: req.user.userId });
            if(!thread){
                return res.status(404).json("Thread not found");
            }
            res.json("Thread deleted successfully");
        }catch(err){
            console.error(err);
            res.status(500).json("Error deleting thread");
        }

    });

router.post("/chat", async (req, res) => {
  const { threadId, message } = req.body || {};

  if (!threadId || !message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "threadId and message are required" });
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
        title: message,
        messages: [{ role: "user", content: message }]
      });
    } else {
      thread.messages = Array.isArray(thread.messages) ? thread.messages : [];
      thread.messages.push({ role: "user", content: message });
    }

    const assistantReply = await getOpenAIResponse(message);

    if (typeof assistantReply !== "string" || !assistantReply.trim()) {
      return res.status(502).json({ error: "AI provider returned an empty response" });
    }

    thread.messages.push({ role: "assistant", content: assistantReply });
    thread.updatedAt = new Date();
    await thread.save();

    return res.json({ reply: assistantReply });
  } catch (err) {
    console.error("Chat error:", err);
    return res.status(500).json({ error: err.message || "Error processing chat" });
  }
});

export default router;