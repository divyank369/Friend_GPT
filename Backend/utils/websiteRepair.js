import { createHash } from "node:crypto";
import { validateReactPreviewProject, validateWebsiteProject } from "./websiteProject.js";

export const MAX_REPAIR_FILES = 5;
export const MAX_REPAIR_PATCH_CHARACTERS = 40_000;
export const MAX_REPAIR_ATTEMPTS = 3;

export function sanitizeDiagnostic(value) {
  return String(value || "")
    .replace(/(?:Bearer\s+)[\w.-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password|authorization|credential|auth)(\s*[=:]\s*)[^\s,;"']+/gi, "$1$2[redacted]")
    .replace(/(?:\/[^\s:]+){2,}/g, (match) => match.replace(/[^/]+/g, "[path]"))
    .slice(0, 8000);
}

export function getRelevantProjectFiles(files, diagnostic, limit = MAX_REPAIR_FILES) {
  const logs = String(diagnostic?.logs || "");
  const referenced = files.filter((file) => logs.includes(file.path) || logs.includes(`/workspace/${file.path}`));
  const preferred = files.filter((file) => /^(?:src\/(?:main|App)\.[jt]sx?|index\.html|package\.json)$/.test(file.path));
  const selected = [...new Map([...referenced, ...preferred].map((file) => [file.path, file])).values()];
  return selected.slice(0, limit);
}

function parseResponse(value) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error();
    const parsed = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw Object.assign(new Error("The repair service returned an invalid structured patch."), { statusCode: 502 });
  }
}

export function validateRepairPatch(value, projectFiles) {
  const candidate = parseResponse(value);
  if (typeof candidate.summary !== "string" || !candidate.summary.trim() || !Array.isArray(candidate.changes) || candidate.changes.length < 1 || candidate.changes.length > MAX_REPAIR_FILES) {
    throw Object.assign(new Error("The repair did not contain a supported set of file changes."), { statusCode: 502 });
  }
  const current = new Map(projectFiles.map((file) => [file.path, file.content]));
  const seen = new Set();
  let patchSize = 0;
  const changes = candidate.changes.map((change) => {
    if (!change || typeof change.path !== "string" || typeof change.content !== "string") {
      throw Object.assign(new Error("The repair contains an invalid file change."), { statusCode: 502 });
    }
    // Reuse the project validator for path normalization rules; only existing project paths may change.
    validateWebsiteProject({ projectType: "react-vite", files: [{ path: change.path, content: change.content }] });
    if (!current.has(change.path) || seen.has(change.path)) {
      throw Object.assign(new Error("The repair attempted to change a file outside this project."), { statusCode: 400 });
    }
    patchSize += change.content.length + current.get(change.path).length;
    if (patchSize > MAX_REPAIR_PATCH_CHARACTERS) throw Object.assign(new Error("The repair exceeded the allowed patch size."), { statusCode: 413 });
    seen.add(change.path);
    return { path: change.path, before: current.get(change.path), after: change.content };
  });
  const files = projectFiles.map((file) => {
    const change = changes.find((item) => item.path === file.path);
    return change ? { ...file, content: change.after } : file;
  });
  validateReactPreviewProject({ projectType: "react-vite", files });
  return { summary: candidate.summary.slice(0, 500), changes, files };
}

export function patchSignature(changes) {
  const canonical = changes.map(({ path, after }) => ({ path, after })).sort((left, right) => left.path.localeCompare(right.path));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function reverseRevision(files, revision) {
  const current = new Map(files.map((file) => [file.path, file.content]));
  for (const change of revision?.changes || []) {
    if (!current.has(change.path)) throw Object.assign(new Error("This revision no longer matches the project files."), { statusCode: 409 });
    if (current.get(change.path) !== change.after) throw Object.assign(new Error("A later change modified this file. Revert the newer revision first."), { statusCode: 409 });
    current.set(change.path, change.before);
  }
  return files.map((file) => ({ ...file, content: current.get(file.path) }));
}
