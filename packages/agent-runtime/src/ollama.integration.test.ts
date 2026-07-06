import { describe, expect, it } from "vitest";
import { TOOL_DESCRIPTORS } from "@chess-agent/agent-tools";
import { OllamaChatModel } from "./ollama.js";

const runIntegration = process.env.RUN_OLLAMA_INTEGRATION === "true";
const model = process.env.MODEL_NAME ?? "qwen3:4b";
const baseUrl = process.env.MODEL_BASE_URL ?? "http://127.0.0.1:11434";

describe.skipIf(!runIntegration)("Ollama model integration", () => {
  it("selects the recent-games tool for a review request", async () => {
    const response = await new OllamaChatModel({ model, baseUrl }).respond({
      messages: [
        { role: "system", content: "You are a chess agent. Use the supplied tools to fulfill requests." },
        { role: "user", content: "Review my most recent completed game." }
      ],
      tools: TOOL_DESCRIPTORS,
      signal: AbortSignal.timeout(120_000)
    });
    expect(response).toMatchObject({ type: "tool_calls", calls: [{ name: "list_recent_games" }] });
  }, 125_000);

  it("has basic pretrained chess knowledge", async () => {
    const response = await new OllamaChatModel({ model, baseUrl }).respond({
      messages: [{ role: "user", content: "In standard chess after 1. e4 e5, give the most common natural developing move for White. Reply only with its SAN." }],
      tools: [],
      signal: AbortSignal.timeout(120_000)
    });
    expect(response).toMatchObject({ type: "final" });
    if (response.type === "final") expect(response.message).toContain("Nf3");
  }, 125_000);
});

