import { describe, expect, it } from "vitest";
import { TOOL_DESCRIPTORS } from "@chess-agent/agent-tools";
import { cleanOllamaContent, OllamaChatModel, toOllamaMessages } from "./ollama.js";

describe("OllamaChatModel", () => {
  it("preserves assistant tool calls and tool outputs", () => {
    expect(toOllamaMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "list_recent_games", arguments: { limit: 1 } }] },
      { role: "tool", toolCallId: "call_1", name: "list_recent_games", content: '{"ok":true}' }
    ])).toEqual([
      { role: "assistant", content: "", tool_calls: [{ function: { name: "list_recent_games", arguments: { limit: 1 } } }] },
      { role: "tool", content: '{"ok":true}' }
    ]);
  });

  it("maps native Ollama tool calls", async () => {
    let request: Record<string, unknown> | undefined;
    const model = new OllamaChatModel({
      fetch: async (_input, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          message: { role: "assistant", content: "", tool_calls: [{ function: { name: "list_recent_games", arguments: { limit: 1 } } }] },
          prompt_eval_count: 12,
          eval_count: 5
        }));
      }
    });
    const response = await model.respond({
      messages: [{ role: "user", content: "Review my last game" }],
      tools: TOOL_DESCRIPTORS,
      signal: new AbortController().signal
    });
    expect(response).toMatchObject({ type: "tool_calls", calls: [{ name: "list_recent_games", arguments: { limit: 1 } }] });
    expect(request).toMatchObject({ model: "qwen3:4b", stream: false, think: false, options: { num_ctx: 8_192 } });
  });

  it("maps final text and token usage", async () => {
    const model = new OllamaChatModel({
      fetch: async () => new Response(JSON.stringify({ message: { content: "The fork wins a rook." }, prompt_eval_count: 9, eval_count: 6 }))
    });
    expect(await model.respond({ messages: [], tools: [], signal: new AbortController().signal })).toEqual({
      type: "final",
      message: "The fork wins a rook.",
      usage: { inputTokens: 9, outputTokens: 6 }
    });
  });

  it("removes model thinking artifacts from user-visible text", () => {
    expect(cleanOllamaContent("private reasoning\n</think>\n\nPlay Nf3.")).toBe("Play Nf3.");
    expect(cleanOllamaContent("<think>private</think>Final answer")).toBe("Final answer");
  });
});
