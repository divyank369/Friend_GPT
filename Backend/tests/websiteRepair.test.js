import assert from "node:assert/strict";
import { test } from "node:test";
import { getRelevantProjectFiles, patchSignature, reverseRevision, sanitizeDiagnostic, validateRepairPatch } from "../utils/websiteRepair.js";

const files = [
  { path: "index.html", content: "<div id=\"root\"></div>" },
  { path: "package.json", content: JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", vite: "^6.0.0" } }) },
  { path: "src/App.jsx", content: "export default function App(){return <div/>}" },
  { path: "src/style.css", content: "body { color: black }" }
];

test("repair output is structured, limited to existing safe project files, and preserves unrelated files", () => {
  const result = validateRepairPatch({ summary: "Fix App syntax", changes: [{ path: "src/App.jsx", content: "export default function App(){return <main/>}" }] }, files);
  assert.equal(result.files.find((file) => file.path === "src/App.jsx").content.includes("<main"), true);
  assert.equal(result.files.find((file) => file.path === "src/style.css").content, files[3].content);
  assert.equal(result.changes[0].before, files[2].content);
  assert.equal(patchSignature(result.changes), patchSignature(result.changes));
});

test("repair rejects traversal, files outside the project, duplicate paths, and oversized patches", () => {
  for (const path of ["../secret.js", "src/../../outside.js"]) {
    assert.throws(() => validateRepairPatch({ summary: "bad", changes: [{ path, content: "bad" }] }, files));
  }
  assert.throws(() => validateRepairPatch({ summary: "bad", changes: [{ path: "src/new.js", content: "bad" }] }, files), /outside this project/);
  assert.throws(() => validateRepairPatch({ summary: "bad", changes: [{ path: "src/App.jsx", content: "x" }, { path: "src/App.jsx", content: "y" }] }, files), /outside this project/);
  assert.throws(() => validateRepairPatch({ summary: "large", changes: [{ path: "src/App.jsx", content: "x".repeat(45_000) }] }, files), /size/);
});

test("revision rollback rejects files changed by a later revision", () => {
  const revision = { changes: [{ path: "src/App.jsx", before: "old", after: "patched" }] };
  assert.throws(() => reverseRevision([{ path: "src/App.jsx", content: "newer" }], revision), /newer revision/);
  assert.equal(reverseRevision([{ path: "src/App.jsx", content: "patched" }], revision)[0].content, "old");
});

test("diagnostic sanitizer redacts credentials and bounds output", () => {
  const clean = sanitizeDiagnostic("Bearer supersecret api_key=another-secret " + "x".repeat(9000));
  assert.equal(clean.includes("supersecret"), false);
  assert.equal(clean.includes("another-secret"), false);
  assert.ok(clean.length <= 8000);
});

test("repair context selects files named by the diagnostic and keeps the fallback bounded", () => {
  assert.deepEqual(getRelevantProjectFiles(files, { logs: "src/style.css: invalid selector" }).map((file) => file.path), ["src/style.css", "index.html", "package.json", "src/App.jsx"]);
  assert.ok(getRelevantProjectFiles(files, { logs: "unknown error" }, 2).length <= 2);
});
