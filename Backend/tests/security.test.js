import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { test } from "node:test";
import requireAuth from "../middleware/requireAuth.js";
import { createOriginGuard, parseAllowedOrigins } from "../security/originPolicy.js";
import { getSessionCookieOptions, SESSION_COOKIE_NAME, SESSION_DURATION_MS } from "../utils/sessionCookie.js";
import { ownerScopedQuery } from "../security/ownerQuery.js";

const validUserId = "507f1f77bcf86cd799439011";
const secret = "test-only-secret-with-at-least-32-bytes-long";

function invokeAuth(token, configuredSecret = secret) {
  const previousSecret = process.env.AUTH_JWT_SECRET;
  if (configuredSecret === null) delete process.env.AUTH_JWT_SECRET;
  else process.env.AUTH_JWT_SECRET = configuredSecret;
  const req = { cookies: token ? { friendgpt_session: token } : {} };
  const result = { statusCode: null, body: null, nextCalled: false };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; }
  };
  requireAuth(req, res, () => { result.nextCalled = true; });
  result.user = req.user;
  if (previousSecret === undefined) delete process.env.AUTH_JWT_SECRET;
  else process.env.AUTH_JWT_SECRET = previousSecret;
  return result;
}

test("session auth accepts signed expiring IDs and rejects malformed, expired, unbounded, or wrongly signed JWTs", () => {
  const valid = jwt.sign({}, secret, { subject: validUserId, expiresIn: "1h" });
  assert.deepEqual(invokeAuth(valid), { statusCode: null, body: null, nextCalled: true, user: { userId: validUserId } });
  assert.equal(invokeAuth("not-a-jwt").statusCode, 401);
  assert.equal(invokeAuth(jwt.sign({}, secret, { subject: validUserId, expiresIn: -1 })).statusCode, 401);
  assert.equal(invokeAuth(jwt.sign({}, secret, { subject: validUserId })).statusCode, 401);
  assert.equal(invokeAuth(jwt.sign({}, secret, { subject: validUserId, expiresIn: "8d" })).statusCode, 401);
  assert.equal(invokeAuth(jwt.sign({}, "different-secret-with-at-least-32-bytes" , { subject: validUserId, expiresIn: "1h" })).statusCode, 401);
  assert.equal(invokeAuth(valid, null).statusCode, 503);
});

test("unsafe API requests require an exact configured origin, including when Origin is absent", () => {
  const guard = createOriginGuard(["https://sigmagpt.example", "http://localhost:5173"]);
  const call = (method, origin) => {
    let nextCalled = false;
    let statusCode;
    const req = { method, headers: { origin } };
    const res = { status(code) { statusCode = code; return this; }, json() { return this; } };
    guard(req, res, () => { nextCalled = true; });
    return { nextCalled, statusCode };
  };
  assert.deepEqual(call("POST", "https://sigmagpt.example"), { nextCalled: true, statusCode: undefined });
  assert.deepEqual(call("POST", undefined), { nextCalled: false, statusCode: 403 });
  assert.deepEqual(call("DELETE", "https://evil.example"), { nextCalled: false, statusCode: 403 });
  assert.deepEqual(call("GET", undefined), { nextCalled: true, statusCode: undefined });
  assert.deepEqual(call("OPTIONS", "https://evil.example"), { nextCalled: true, statusCode: undefined });
});

test("production cookie defaults support the cross-site Render deployment securely", () => {
  const options = getSessionCookieOptions({ NODE_ENV: "production" });
  assert.deepEqual(options, { httpOnly: true, secure: true, sameSite: "none", path: "/" });
  assert.equal(SESSION_COOKIE_NAME, "friendgpt_session");
  assert.equal(SESSION_DURATION_MS, 7 * 24 * 60 * 60 * 1000);
  assert.deepEqual(getSessionCookieOptions({ NODE_ENV: "development" }), {
    httpOnly: true, secure: false, sameSite: "lax", path: "/"
  });
  assert.throws(() => getSessionCookieOptions({ NODE_ENV: "production", SESSION_COOKIE_SAME_SITE: "invalid" }), /must be lax/);
  assert.deepEqual(getSessionCookieOptions({ NODE_ENV: "production", SESSION_COOKIE_SAME_SITE: "none" }), {
    httpOnly: true, secure: true, sameSite: "none", path: "/"
  });
});

test("configured frontend origins must be exact HTTP or HTTPS origins", () => {
  assert.deepEqual(parseAllowedOrigins("https://sigmagpt.example,https://admin.sigmagpt.example"), [
    "https://sigmagpt.example", "https://admin.sigmagpt.example"
  ]);
  for (const invalid of ["*", "https://sigmagpt.example/path", "javascript:alert(1)", "not-an-origin"]) {
    assert.throws(() => parseAllowedOrigins(invalid), /FRONTEND_ORIGIN/);
  }
});

test("resource lookups always constrain the authenticated owner, even for attacker-supplied criteria", () => {
  const criteria = { threadId: "guessed-thread", ownerId: "attacker-controlled" };
  const query = ownerScopedQuery("alice-id", criteria);
  assert.deepEqual(query, { threadId: "guessed-thread", ownerId: "alice-id" });
  assert.equal(query.ownerId === "bob-id", false);
  assert.deepEqual(ownerScopedQuery("alice-id", { _id: "file-id" }, "metadata.ownerId"), {
    _id: "file-id", "metadata.ownerId": "alice-id"
  });
});
