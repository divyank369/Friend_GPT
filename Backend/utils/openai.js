import "dotenv/config";

const getOpenAIResponse = async (message) => {
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [
        {
          role: "user",
          content: message
        }
      ]
    })
  };

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", options);
    const data = await response.json();

    if (!response.ok) {
      const apiError = data?.error?.message || "AI provider request failed";
      throw new Error(apiError);
    }

    const aiText = data?.choices?.[0]?.message?.content;

    if (typeof aiText !== "string" || !aiText.trim()) {
      throw new Error("AI response was empty or malformed");
    }

    return aiText;
  } catch (err) {
    console.error("getOpenAIResponse error:", err);
    throw err;
  }
};

export default getOpenAIResponse;