 import express from "express";
 import "dotenv/config"; 
 import cors from "cors";
 import cookieParser from "cookie-parser";
 import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
 import chatRoutes from "./routes/chat.js";
 import authRoutes from "./routes/auth.js";


 const app = express();

 const PORT = process.env.PORT || 8080;
const allowedOrigins = (process.env.FRONTEND_ORIGIN || (process.env.NODE_ENV === "production" ? "" : "http://localhost:5173"))
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.set("trust proxy", 1);
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.includes(origin));
  },
  credentials: true
}));
app.use((req, res, next) => {
  const origin = req.get("Origin");
  const changesState = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  if (changesState && origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: "Request origin is not allowed" });
  }
  return next();
});
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again shortly." }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts. Please try again later." }
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "You are sending messages too quickly. Please try again shortly." }
});

app.use("/api", apiLimiter);
app.use("/api/auth", (req, res, next) => {
  const authPath = req.path.replace(/\/+$/, "") || "/";
  if (req.method === "POST" && ["/signup", "/login", "/google"].includes(authPath)) {
    return authLimiter(req, res, next);
  }
  return next();
}, authRoutes);
app.use("/api/chat", chatLimiter);
app.use("/api", chatRoutes);

app.use((error, _req, res, _next) => {
  const statusCode = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
  const message = statusCode === 413
    ? "Request body is too large"
    : statusCode === 400
      ? "Request body must contain valid JSON"
      : "An unexpected server error occurred";
  if (statusCode === 500) console.error("Unhandled API error:", error);
  return res.status(statusCode).json({ error: message });
});

app.get("/health", (_req, res) => {
  const databaseReady = mongoose.connection.readyState === 1;
  res.status(databaseReady ? 200 : 503).json({
    status: databaseReady ? "ok" : "database-unavailable"
  });
});

const startServer = async () => {
  const requiredEnvironment = ["MONGODB_URI", "AUTH_JWT_SECRET", "GROQ_API_KEY"];
  if (process.env.NODE_ENV === "production") requiredEnvironment.push("FRONTEND_ORIGIN");
  const missingEnvironment = requiredEnvironment.filter((key) => !process.env[key]);
  if (missingEnvironment.length) {
    throw new Error(`Missing required environment variables: ${missingEnvironment.join(", ")}`);
  }
  if (process.env.NODE_ENV === "production" && Buffer.byteLength(process.env.AUTH_JWT_SECRET, "utf8") < 32) {
    throw new Error("AUTH_JWT_SECRET must contain at least 32 bytes");
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
};

startServer().catch((error) => {
  console.error("Server startup failed:", error.message);
  process.exit(1);
});

