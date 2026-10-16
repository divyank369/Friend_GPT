import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import express from "express";
import cookieParser from "cookie-parser";
import { createServer } from "node:http";
import User from "../models/User.js";
import authRoutes from "../routes/auth.js";
import { createOriginGuard } from "../security/originPolicy.js";

const originalSecret = process.env.AUTH_JWT_SECRET;
const allowedOrigin = "https://frontend.example.test";

afterEach(() => {
  mock.restoreAll();
  if (originalSecret === undefined) delete process.env.AUTH_JWT_SECRET;
  else process.env.AUTH_JWT_SECRET = originalSecret;
});

async function withTestServer(run) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(createOriginGuard([allowedOrigin]));
  app.use("/api/auth", authRoutes);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("signup issues an HTTP-only session cookie usable by the authenticated profile route", async () => {
  process.env.AUTH_JWT_SECRET = "test-only-signing-secret-that-is-at-least-32-bytes";
  const user = {
    _id: "0123456789abcdef01234567",
    name: "Test Person",
    email: "test@example.test",
    preferredName: "",
    avatarUrl: ""
  };
  mock.method(User, "exists", async () => null);
  mock.method(User, "create", async (values) => ({ ...user, ...values }));
  mock.method(User, "findById", async () => user);

  await withTestServer(async (baseUrl) => {
    const signup = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: allowedOrigin },
      body: JSON.stringify({ name: user.name, email: user.email, password: "correct-horse-battery" })
    });
    assert.equal(signup.status, 201);
    assert.equal((await signup.json()).user.email, user.email);

    const setCookie = signup.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/i);
    const cookie = setCookie.split(";")[0];
    const profile = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).user.id, user._id);

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Origin: allowedOrigin, Cookie: cookie }
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /friendgpt_session=;/);
  });
});

test("rejects an unsafe authentication request from an unconfigured origin", async () => {
  process.env.AUTH_JWT_SECRET = "test-only-signing-secret-that-is-at-least-32-bytes";
  const exists = mock.method(User, "exists", async () => null);

  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example.test" },
      body: JSON.stringify({ name: "Test Person", email: "test@example.test", password: "correct-horse-battery" })
    });
    assert.equal(response.status, 403);
    assert.equal(exists.mock.callCount(), 0);
  });
});
