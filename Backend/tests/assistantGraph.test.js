import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import KnowledgeChunk from "../models/KnowledgeChunk.js";
import { runAssistant } from "../ai/assistantGraph.js";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.GROQ_API_KEY;
const originalModel = process.env.GROQ_MODEL;
const encoder = new TextEncoder();
let lastProviderPayload;

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalApiKey;
  if (originalModel === undefined) delete process.env.GROQ_MODEL;
  else process.env.GROQ_MODEL = originalModel;
});

function mockProvider() {
  process.env.GROQ_API_KEY = "test-key";
  process.env.GROQ_MODEL = "test-text-model";
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    lastProviderPayload = payload;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Answer" } }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
}

test("retrieves only the requesting user's knowledge and passes matching context", async () => {
  mockProvider();
  let capturedQuery;
  mock.method(KnowledgeChunk, "find", (query) => {
    capturedQuery = query;
    return {
      sort() { return this; },
      limit() { return this; },
      async lean() { return [{ title: "My notes", content: "private matching detail", sourceId: "source-a" }]; }
    };
  });

  const reply = await runAssistant({
    userId: "user-123",
    messages: [{ role: "user", content: "Tell me about my notes" }]
  });

  assert.equal(reply, "Answer");
  assert.equal(capturedQuery.ownerId, "user-123");
  assert.match(lastProviderPayload.messages[2].content, /private matching detail/);
});

test("continues with no reference context when retrieval fails", async () => {
  mockProvider();
  mock.method(KnowledgeChunk, "find", () => { throw new Error("database failure with private query"); });

  const reply = await runAssistant({
    userId: "user-456",
    messages: [{ role: "user", content: "Answer without failing" }]
  });

  assert.equal(reply, "Answer");
  assert.match(lastProviderPayload.messages[2].content, /No matching user reference material/);
});
