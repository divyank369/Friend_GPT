import jwt from "jsonwebtoken";

export default function requireAuth(req, res, next) {
    const secret = process.env.AUTH_JWT_SECRET;
    if (!secret) {
        return res.status(503).json({ error: "Authentication is not configured on the server" });
    }

    const token = req.cookies?.friendgpt_session;
    if (!token) {
        return res.status(401).json({ error: "Authentication required" });
    }

    try {
        const payload = jwt.verify(token, secret);
        if (typeof payload === "string" || typeof payload.sub !== "string") {
            return res.status(401).json({ error: "Invalid session" });
        }
        req.user = { userId: payload.sub };
        return next();
    } catch {
        return res.status(401).json({ error: "Session expired or invalid" });
    }
}