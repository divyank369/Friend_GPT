import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import KnowledgeChunk from "../models/KnowledgeChunk.js";
import getGroqResponse from "../utils/openai.js";

const AssistantState = Annotation.Root({
  userId: Annotation({ reducer: (_current, update) => update, default: () => "" }),
  messages: Annotation({ reducer: (_current, update) => update, default: () => [] }),
  images: Annotation({ reducer: (_current, update) => update, default: () => [] }),
  preferredName: Annotation({ reducer: (_current, update) => update, default: () => "" }),
  knowledgeContext: Annotation({ reducer: (_current, update) => update, default: () => [] }),
  assistantReply: Annotation({ reducer: (_current, update) => update, default: () => "" })
});

async function retrieveKnowledge(state) {
  const latestUserMessage = [...state.messages].reverse().find((message) => message.role === "user");
  if (!latestUserMessage?.content?.trim()) return { knowledgeContext: [] };

  // MongoDB text search provides durable lexical RAG without requiring a new vector service.
  const matches = await KnowledgeChunk.find({
    ownerId: state.userId,
    $text: { $search: latestUserMessage.content.slice(0, 500) }
  }, {
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
    state.preferredName
  );
  return { assistantReply };
}

// Explicit graph nodes make retrieval and answer generation independently observable and extensible.
const assistantGraph = new StateGraph(AssistantState)
  .addNode("retrieveKnowledge", retrieveKnowledge)
  .addNode("generateResponse", generateResponse)
  .addEdge(START, "retrieveKnowledge")
  .addEdge("retrieveKnowledge", "generateResponse")
  .addEdge("generateResponse", END)
  .compile();

export async function runAssistant({ userId, messages, images = [], preferredName = "", onToken, signal }) {
  const result = await assistantGraph.invoke(
    { userId, messages, images, preferredName },
    { configurable: { onToken, signal } }
  );
  return result.assistantReply;
}
