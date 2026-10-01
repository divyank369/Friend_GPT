import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import User from "../models/User.js";
import requireAuth from "../middleware/requireAuth.js";

const router = express.Router();
const googleClient = new OAuth2Client();
const cookieName = "friendgpt_session";
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;

function publicUser(user) {
    return {
        id: user._id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl || ""
    };
}

function setSessionCookie(res, user) {
    const secret = process.env.AUTH_JWT_SECRET;
    if (!secret) {
        throw new Error("Authentication is not configured on the server");
    }

    const token = jwt.sign({}, secret, {
        subject: user._id.toString(),
        expiresIn: "7d"
    });
    res.cookie(cookieName, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: sessionDurationMs
    });
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post("/signup", async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (name.length < 2 || name.length > 80 || !isValidEmail(email) || password.length < 8 || password.length > 128) {
        return res.status(400).json({ error: "Enter a name, valid email, and password of 8 to 128 characters" });
    }

    try {
        if (!process.env.AUTH_JWT_SECRET) {
            return res.status(503).json({ error: "Authentication is not configured on the server" });
        }
        if (await User.exists({ email })) {
            return res.status(409).json({ error: "An account with this email already exists" });
        }

        const user = await User.create({
            name,
            email,
            passwordHash: await bcrypt.hash(password, 12)
        });
        setSessionCookie(res, user);
        return res.status(201).json({ user: publicUser(user) });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ error: "An account with this email already exists" });
        }
        console.error("Signup error:", error);
        return res.status(500).json({ error: "Could not create account" });
    }
});

router.post("/login", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!isValidEmail(email) || !password) {
        return res.status(400).json({ error: "Enter a valid email and password" });
    }

    try {
        if (!process.env.AUTH_JWT_SECRET) {
            return res.status(503).json({ error: "Authentication is not configured on the server" });
        }
        const user = await User.findOne({ email }).select("+passwordHash");
        if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
            return res.status(401).json({ error: "Incorrect email or password" });
        }

        setSessionCookie(res, user);
        return res.json({ user: publicUser(user) });
    } catch (error) {
        console.error("Login error:", error);
        return res.status(500).json({ error: "Could not sign in" });
    }
});

router.post("/google", async (req, res) => {
    const idToken = req.body?.idToken;
    if (typeof idToken !== "string" || !idToken) {
        return res.status(400).json({ error: "Google credential is required" });
    }
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.AUTH_JWT_SECRET) {
        return res.status(503).json({ error: "Google sign-in is not configured on the server" });
    }

    try {
        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        if (!payload?.sub || !payload.email || payload.email_verified !== true) {
            return res.status(401).json({ error: "Google account email could not be verified" });
        }

        const email = payload.email.toLowerCase();
        let user = await User.findOne({ $or: [{ googleId: payload.sub }, { email }] });
        if (user?.googleId && user.googleId !== payload.sub) {
            return res.status(409).json({ error: "This email is linked to another Google account" });
        }
        if (!user) {
            user = new User({
                name: payload.name || email.split("@")[0],
                email,
                googleId: payload.sub,
                avatarUrl: payload.picture || ""
            });
        } else {
            user.googleId = payload.sub;
            user.avatarUrl = payload.picture || user.avatarUrl;
        }
        await user.save();
        setSessionCookie(res, user);
        return res.json({ user: publicUser(user) });
    } catch (error) {
        console.error("Google sign-in error:", error);
        return res.status(401).json({ error: "Google sign-in could not be verified" });
    }
});

router.get("/me", requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user) {
            res.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", path: "/" });
            return res.status(401).json({ error: "Account no longer exists" });
        }
        return res.json({ user: publicUser(user) });
    } catch (error) {
        console.error("Session lookup error:", error);
        return res.status(500).json({ error: "Could not verify session" });
    }
});

router.post("/logout", (req, res) => {
    res.clearCookie(cookieName, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/"
    });
    return res.json({ message: "Signed out" });
});

export default router;