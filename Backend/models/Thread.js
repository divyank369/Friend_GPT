import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ["user", "assistant"],
    required: true
  },
  content: {
    type: String,
        required: true,
        maxlength: 16000
  },
  // Store only owner-checked file metadata in thread documents, never image bytes.
  attachments: [{
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
    filename: { type: String, maxlength: 255, default: "image" },
    contentType: { type: String, enum: ["image/png", "image/jpeg", "image/webp"], required: true }
  }],
    timestamp: {
        type: Date,
        default: Date.now
    }
});

const threadSchema = new mongoose.Schema({
    ownerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true
    },
    threadId: {
        type: String,
        required: true,
            maxlength: 128,
        unique: true
    },
    title:{
        type: String,
                default: "New chat",
                maxlength: 120
    },
    messages: {
        type: [messageSchema],
        default: []
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

threadSchema.index({ ownerId: 1, updatedAt: -1 });

export default mongoose.model("Thread",threadSchema);
