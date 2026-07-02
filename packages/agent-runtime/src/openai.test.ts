import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { TOOL_DESCRIPTORS } from "@chess-agent/agent-tools";
import { OpenAIResponsesModel, toResponseInput } from "./openai.js";

describe("OpenAIResponsesModel", () => {
  it("preserves native function calls and outputs", () => {
    const input = toResponseInput([
      { role: "system", content: "policy" },
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "create_game", arguments: { mode: "computer", color: "white" } }]
      },
      { role: "tool", toolCallId: "call_1", name: "create_game", content: '{"ok":true}' }
    ]);
    expect(input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call_1" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_1" })
    ]));
  });

  it("maps Responses API function calls", async () => {
    let request: unknown;
    const client = {
      responses: {
        create: async (body: unknown) => {
          request = body;
          return {
            output: [{ type: "function_call", call_id: "call_1", name: "list_recent_games", arguments: '{"limit":1}' }],
            output_text: "",
            usage: { input_tokens: 10, output_tokens: 4 }
          };
        }
      }
    } as unknown as Pick<OpenAI, "responses">;
    const model = new OpenAIResponsesModel({ client, model: "test-model" });
    const response = await model.respond({
      messages: [{ role: "user", content: "last game" }],
      tools: TOOL_DESCRIPTORS,
      signal: new AbortController().signal
    });
    expect(response).toMatchObject({
      type: "tool_calls",
      calls: [{ id: "call_1", name: "list_recent_games", arguments: { limit: 1 } }],
      usage: { inputTokens: 10, outputTokens: 4 }
    });
    expect(request).toMatchObject({ model: "test-model", parallel_tool_calls: false });
  });

  it("maps final text", async () => {
    const client = {
      responses: {
        create: async () => ({ output: [], output_text: "Your review is ready.", usage: null })
      }
    } as unknown as Pick<OpenAI, "responses">;
    const response = await new OpenAIResponsesModel({ client }).respond({
      messages: [{ role: "user", content: "review" }],
      tools: [],
      signal: new AbortController().signal
    });
    expect(response).toEqual({ type: "final", message: "Your review is ready.", usage: { inputTokens: 0, outputTokens: 0 } });
  });
});

