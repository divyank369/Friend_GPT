import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { projectRevision, validateDeploymentAssets } from "../utils/deploymentValidation.js";

function asset(path, content) {
  const bytes = Buffer.from(content);
  return { path, content: bytes.toString("base64"), contentType: path.endsWith(".html") ? "text/html" : "application/javascript", hash: createHash("sha256").update(bytes).digest("hex") };
}

test("validates built files and produces a stable source revision", () => {
  const files = [asset("index.html", "<main>Hello</main>"), asset("assets/app.js", "console.log('ok')")];
  assert.equal(validateDeploymentAssets(files).length, 2);
  assert.equal(projectRevision([{ path: "b.js", content: "b" }, { path: "a.js", content: "a" }]), projectRevision([{ path: "a.js", content: "a" }, { path: "b.js", content: "b" }]));
});

test("rejects traversal, duplicate paths, tampered hashes, and secrets from a publish artifact", () => {
  const valid = asset("index.html", "<main>ok</main>");
  assert.throws(() => validateDeploymentAssets([{ ...valid, path: "../index.html" }]), /unsafe/);
  assert.throws(() => validateDeploymentAssets([valid, valid]), /unsafe/);
  assert.throws(() => validateDeploymentAssets([{ ...valid, hash: "0".repeat(64) }]), /integrity/);
  assert.throws(() => validateDeploymentAssets([asset("index.html", "const api_key = 'this-is-a-long-private-value';")]), /credential/);
  assert.throws(() => validateDeploymentAssets([asset("index.html", `const token = "sk-${"a".repeat(26)}";`)]), /credential/);
  assert.throws(() => validateDeploymentAssets([asset(".env", "API_KEY=private")]), /unsafe/);
  assert.throws(() => validateDeploymentAssets([asset("app.js", "console.log(1)")]), /index.html/);
});
