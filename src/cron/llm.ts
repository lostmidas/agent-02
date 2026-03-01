import Anthropic from "@anthropic-ai/sdk";

export async function callLLM(prompt: string): Promise<string> {
  const agentId = process.env.AGENT_ID ?? "unknown";

  const client = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
  });

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    const rawResponse = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    console.log("[llm] raw response:", rawResponse);
    return rawResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`CRON ERROR: LLM call failed for ${agentId} — ${message}`);
    throw error;
  }
}
