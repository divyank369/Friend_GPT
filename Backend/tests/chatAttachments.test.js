import assert from "node:assert/strict";
import { test } from "node:test";
import { selectModelAttachmentIds } from "../utils/chatAttachments.js";

const history = [{ role: "user", content: "Review these files", attachments: [
  { fileId: "old-image", contentType: "image/png" },
  { fileId: "old-pdf", contentType: "application/pdf" }
] }];

test("text follow-ups do not inherit earlier attachments", () => {
  assert.deepEqual(selectModelAttachmentIds("What are the next steps?", history), []);
});

test("an explicit image reference reuses image context but not an earlier PDF", () => {
  assert.deepEqual(selectModelAttachmentIds("What does this picture show?", history), ["old-image"]);
});

test("newly selected attachments remain attached to their message", () => {
  assert.deepEqual(selectModelAttachmentIds("Summarize this", history, ["new-pdf"]), ["new-pdf"]);
});
