import jwt from "jsonwebtoken";

const maxSessionAgeSeconds = 7 * 24 * 60 * 60;

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
        const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (
            typeof payload === "string" ||
            !/^[a-f\d]{24}$/i.test(payload.sub || "") ||
            !Number.isFinite(payload.iat) ||
            !Number.isFinite(payload.exp) ||
            payload.iat > nowSeconds + 60 ||
            payload.exp <= payload.iat ||
            payload.exp - payload.iat > maxSessionAgeSeconds
        ) {
            return res.status(401).json({ error: "Invalid session" });
        }
        req.user = { userId: payload.sub };
        return next();
    } catch {
        return res.status(401).json({ error: "Session expired or invalid" });
    }
}
