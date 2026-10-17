import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCloudflarePagesAdapter } from "../utils/providers/cloudflarePages.js";

const originalFetch = globalThis.fetch;
const oldEnv = Object.fromEntries(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"].map((key) => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function asset() {
  const bytes = Buffer.from("<h1>hello</h1>");
  return { path: "index.html", content: bytes.toString("base64"), contentType: "text/html", hash: createHash("sha256").update(bytes).digest("hex") };
}

test("Cloudflare Pages Direct Upload uses validated project APIs and returns its stable public URL", async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "b".repeat(32);
  process.env.CLOUDFLARE_API_TOKEN = "server-side-cloudflare-pages-token-test";
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || "GET", auth: options.headers?.Authorization });
    if (path.endsWith("/pages/projects/sg-test")) return options.method === "POST" ? json({ success: true, result: { name: "sg-test" } }) : json({ success: false, errors: [] }, 404);
    if (path.endsWith("/upload-token")) return json({ success: true, result: { jwt: "short-lived-jwt-token-for-tests" } });
    if (path.endsWith("/assets/check-missing")) return json({ success: true, result: [asset().hash] });
    if (path.endsWith("/assets/upload")) return json({ success: true });
    if (path.endsWith("/deployments")) {
      assert.equal(options.body.get("branch"), "main");
      assert.equal(JSON.parse(options.body.get("manifest"))["index.html"], asset().hash);
      return json({ success: true, result: { id: "d81a0ba9-3d89-4b40-9fa1-acdeedaa1122", url: "https://preview.sg-test.pages.dev", aliases: ["https://sg-test.pages.dev"], latest_stage: { status: "success" } } });
    }
    if (path.endsWith("/deployments/d81a0ba9-3d89-4b40-9fa1-acdeedaa1122") && options.method === "DELETE") return json({ success: true, result: { id: "d81a0ba9-3d89-4b40-9fa1-acdeedaa1122" } });
    throw new Error(`Unexpected endpoint: ${path}`);
  };
  const adapter = createCloudflarePagesAdapter();
  assert.equal(adapter.projectName("b7614d5b-9923-4be0-9d23-a4539b78c8f9"), "sg-b7614d5b99234be09d23a4539b78c8f9");
  const result = await adapter.deploy("sg-test", [asset()]);
  assert.equal(result.status, "success");
  assert.equal(result.publicUrl, "https://sg-test.pages.dev");
  assert.ok(calls.some((call) => call.path.endsWith("/assets/upload")));
  assert.ok(calls.filter((call) => call.path.includes("/assets/")).every((call) => call.auth === "Bearer short-lived-jwt-token-for-tests"));
  assert.equal((await adapter.deleteDeployment("sg-test", result.id)).deleted, true);
});

test("Cloudflare Pages adapter maps provider errors and timeouts without exposing provider details", async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "b".repeat(32);
  process.env.CLOUDFLARE_API_TOKEN = "server-side-cloudflare-pages-token-test";
  const adapter = createCloudflarePagesAdapter();
  globalThis.fetch = async () => json({ success: false, errors: [{ message: "private provider response and token value" }] }, 403);
  await assert.rejects(adapter.status("sg-test", "d81a0ba9-3d89-4b40-9fa1-acdeedaa1122"), (error) => {
    assert.match(error.message, /rejected/i);
    assert.equal(error.message.includes("token value"), false);
    return true;
  });
  globalThis.fetch = async () => { const error = new Error("socket internals"); error.name = "TimeoutError"; throw error; };
  await assert.rejects(adapter.status("sg-test", "d81a0ba9-3d89-4b40-9fa1-acdeedaa1122"), /timed out/i);
});

test("Cloudflare Pages credentials are required only on the server", async () => {
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  assert.throws(() => createCloudflarePagesAdapter(), (error) => error.statusCode === 503 && /not configured/i.test(error.message));
});
