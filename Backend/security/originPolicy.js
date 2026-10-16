const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function parseAllowedOrigins(value, fallback = "http://localhost:5173") {
  const configured = (value || fallback).split(",").map((item) => item.trim()).filter(Boolean);
  return [...new Set(configured.map((origin) => {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("FRONTEND_ORIGIN must contain comma-separated HTTP or HTTPS origins");
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== origin) {
      throw new Error("FRONTEND_ORIGIN entries must be exact HTTP or HTTPS origins without paths");
    }
    return parsed.origin;
  }))];
}

export function createOriginGuard(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    if (!unsafeMethods.has(req.method)) return next();
    const origin = req.get ? req.get("Origin") : req.headers?.origin;
    if (!origin || !allowed.has(origin)) {
      return res.status(403).json({ error: "Request origin is not allowed" });
    }
    return next();
  };
}
