import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import getGroqResponse from "../utils/openai.js";

const originalEnvironment = {
  apiKey: process.env.GROQ_API_KEY,
  apiUrl: process.env.GROQ_API_URL,
  model: process.env.GROQ_MODEL
};
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.GROQ_API_KEY = "test-key";
  delete process.env.GROQ_API_URL;
  delete process.env.GROQ_MODEL;
});

afterEach(() => {
  if (originalEnvironment.apiKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalEnvironment.apiKey;
  if (originalEnvironment.apiUrl === undefined) delete process.env.GROQ_API_URL;
  else process.env.GROQ_API_URL = originalEnvironment.apiUrl;
  if (originalEnvironment.model === undefined) delete process.env.GROQ_MODEL;
  else process.env.GROQ_MODEL = originalEnvironment.model;
  globalThis.fetch = originalFetch;
});

test("sends conversation context and returns the assistant response", async () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" }
  ];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    const requestBody = JSON.parse(options.body);
    assert.equal(requestBody.model, "openai/gpt-oss-20b");
    assert.equal(requestBody.max_tokens, 2048);
    assert.equal(requestBody.messages[0].role, "system");
    assert.match(requestBody.messages[0].content, /You are SigmaGPT/);
    assert.match(requestBody.messages[0].content, /Do not claim to be the ChatGPT application/);
    assert.equal(requestBody.messages[0].content.includes("openai/gpt-oss-20b"), true);
    assert.deepEqual(requestBody.messages.slice(1), messages);
    return Response.json({ choices: [{ message: { content: "A checked response." } }] });
  };

  assert.equal(await getGroqResponse(messages), "A checked response.");
});

test("maps provider rate limits without exposing provider details", async () => {
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: "private provider details" } }),
    { status: 429 }
  );

  await assert.rejects(
    getGroqResponse([{ role: "user", content: "hello" }]),
    (error) => error.statusCode === 503 && !error.message.includes("private provider")
  );
});

test("rejects malformed successful responses", async () => {
  globalThis.fetch = async () => Response.json({ choices: [] });

  await assert.rejects(
    getGroqResponse([{ role: "user", content: "hello" }]),
    (error) => error.statusCode === 502 && error.message === "AI service returned an invalid response"
  );
});

test("fails clearly when the provider key is missing", async () => {
  delete process.env.GROQ_API_KEY;

  await assert.rejects(
    getGroqResponse([{ role: "user", content: "hello" }]),
    (error) => error.statusCode === 503 && error.message === "AI service is not configured"
  );
});
