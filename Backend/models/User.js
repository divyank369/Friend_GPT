import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
        maxlength: 80
    },
    // Persist the name the assistant should use across every conversation.
    preferredName: {
        type: String,
        trim: true,
        maxlength: 80,
        default: ""
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        maxlength: 254
    },
    passwordHash: {
        type: String,
        select: false
    },
    googleId: {
        type: String,
        unique: true,
        sparse: true
    },
    avatarUrl: {
        type: String,
        maxlength: 2048,
        default: ""
    },
    websiteDeploymentLockUntil: { type: Date, default: null }
}, { timestamps: true });

export default mongoose.model("User", userSchema);
