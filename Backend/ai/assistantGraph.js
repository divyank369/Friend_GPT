import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import KnowledgeChunk from "../models/KnowledgeChunk.js";
import getGroqResponse from "../utils/openai.js";
import { ownerScopedQuery } from "../security/ownerQuery.js";

const AssistantState = Annotation.Root({
  userId: Annotation({ reducer: (_current, update) => update, default: () => "" }),
  requestId: Annotation({ reducer: (_current, update) => update, default: () => "" }),
  messages: Annotation({ reducer: (_current, update) => update, default: () => [] }),
  images: Annotation({ reducer: (_current, update) => update, default: () => [] }),
  requestMode: Annotation({ reducer: (_current, update) => update, default: () => "agent" }),
  allowLiveTools: Annotation({ reducer: (_current, update) => update, default: () => false }),
  preferredName: Annotation({ reducer: (_current, update) => update, default: () => "" }),
  knowledgeContext: Annotation({ reducer: (_current, update) => update, default: () => [] }),
  assistantReply: Annotation({ reducer: (_current, update) => update, default: () => "" })
});

async function retrieveKnowledge(state) {
  const latestUserMessage = [...state.messages].reverse().find((message) => message.role === "user");
  if (!latestUserMessage?.content?.trim()) return { knowledgeContext: [] };

  // MongoDB text search provides durable lexical RAG without requiring a new vector service.
  try {
    const matches = await KnowledgeChunk.find(ownerScopedQuery(state.userId, {
      $text: { $search: latestUserMessage.content.slice(0, 500) }
    }), {
      title: 1,
      content: 1,
      sourceId: 1,
      score: { $meta: "textScore" }
    })
      .sort({ score: { $meta: "textScore" } })
      .limit(4)
      .lean();

    return {
      knowledgeContext: matches.map(({ title, content, sourceId }) => ({ title, content, sourceId }))
    };
  } catch (error) {
    // A database/index hiccup should not turn a normal assistant request into
    // a failed chat. Do not log the query: it can contain private user text.
    console.warn("Knowledge retrieval unavailable", { name: error.name });
    return { knowledgeContext: [] };
  }
}

function planRequest(state) {
  // Keep image understanding on the dedicated vision model; text requests can
  // use the agent model's read-only live search and calculation tools.
  const requestMode = state.images.length ? "vision" : "agent";
  const allowLiveTools = requestMode === "agent";
  console.info("Agent request planned", {
    requestId: state.requestId,
    mode: requestMode,
    knowledgeEnabled: true,
    liveToolsEnabled: allowLiveTools
  });
  return { requestMode, allowLiveTools };
}

async function generateResponse(state, config) {
  // Keep the existing streaming provider adapter while making retrieval and generation explicit graph steps.
  const assistantReply = await getGroqResponse(
    state.messages.map((message, index) => index === state.messages.length - 1 && state.images.length
      ? { ...message, content: [
        { type: "text", text: message.content },
        ...state.images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } }))
      ] }
      : message),
    config.configurable?.onToken,
    config.configurable?.signal,
    state.knowledgeContext,
    state.preferredName,
    {
      allowLiveTools: state.allowLiveTools,
      onStatus: config.configurable?.onStatus,
      requestId: state.requestId
    }
  );
  return { assistantReply };
}

// Explicit graph nodes make retrieval and answer generation independently observable and extensible.
const assistantGraph = new StateGraph(AssistantState)
  .addNode("planRequest", planRequest)
  .addNode("retrieveKnowledge", retrieveKnowledge)
  .addNode("generateResponse", generateResponse)
  .addEdge(START, "planRequest")
  .addEdge("planRequest", "retrieveKnowledge")
  .addEdge("retrieveKnowledge", "generateResponse")
  .addEdge("generateResponse", END)
  .compile();

export async function runAssistant({ userId, requestId = "", messages, images = [], preferredName = "", onToken, onStatus, signal }) {
  const result = await assistantGraph.invoke(
    { userId, requestId, messages, images, preferredName },
    { configurable: { onToken, onStatus, signal } }
  );
  return result.assistantReply;
}
