import { createHash } from "node:crypto";

const MAX_DEPLOYMENT_FILES = 500;
const MAX_DEPLOYMENT_BYTES = 18 * 1024 * 1024;
const forbiddenFile = /(?:^|\/)(?:\.env(?:\..*)?|\.git|node_modules)(?:\/|$)|\.(?:pem|key|p12|pfx|crt|cer)$/i;
const secretContent = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|client[_-]?secret|password|access[_-]?token|secret)\s*[:=]\s*["'][^"']{12,}["']|\b(?:sk-[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[a-z0-9-]{20,})\b/i;

export function validateDeploymentAssets(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DEPLOYMENT_FILES) {
    throw new Error("The production build did not contain a supported number of files.");
  }
  let totalBytes = 0;
  const seen = new Set();
  const files = value.map((file) => {
    const filePath = file?.path;
    if (typeof filePath !== "string" || filePath.length > 240 || filePath.startsWith("/") || filePath.includes("\\") || filePath.includes("\0") || filePath.split("/").some((part) => !part || part === "." || part === "..") || forbiddenFile.test(filePath) || seen.has(filePath)) {
      throw new Error("The production build contains an unsafe or private file.");
    }
    if (typeof file.content !== "string" || !/^[a-f0-9]{64}$/.test(file.hash || "") || !/^[\w.+-]+\/[\w.+-]+$/.test(file.contentType || "")) {
      throw new Error("The production build returned an invalid file.");
    }
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.toString("base64") !== file.content) throw new Error("The production build returned an invalid file.");
    totalBytes += bytes.length;
    if (totalBytes > MAX_DEPLOYMENT_BYTES) throw new Error("The production build exceeds the 18 MB publish limit.");
    if (secretContent.test(bytes.toString("utf8"))) throw new Error("A build file appears to contain a private key or credential and was not published.");
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== file.hash) throw new Error("The production build failed its file integrity check.");
    seen.add(filePath);
    return { path: filePath, content: file.content, contentType: file.contentType, hash };
  });
  if (!files.some((file) => file.path === "index.html")) throw new Error("The production build is missing index.html.");
  return files;
}

export function projectRevision(files) {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256").update(JSON.stringify(sorted.map(({ path, content }) => [path, content]))).digest("hex");
}
