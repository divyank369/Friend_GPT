import "dotenv/config";

class AIProviderError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

const getGroqResponse = async (messages) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new AIProviderError("AI service is not configured", 503);

  try {
    const response = await fetch(process.env.GROQ_API_URL || "https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
        messages,
        max_tokens: 2048
      }),
      signal: AbortSignal.timeout(30000)
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const statusCode = response.status === 429 ? 503 : 502;
      throw new AIProviderError("AI service is temporarily unavailable", statusCode);
    }

    const aiText = data?.choices?.[0]?.message?.content;

    if (typeof aiText !== "string" || !aiText.trim()) {
      throw new AIProviderError("AI service returned an invalid response", 502);
    }

    return aiText;
  } catch (err) {
    if (err instanceof AIProviderError) throw err;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new AIProviderError("AI service timed out. Please try again.", 504);
    }
    throw new AIProviderError("AI service is temporarily unavailable", 502);
  }
};

export default getGroqResponse;