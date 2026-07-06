import { randomUUID } from "node:crypto";
import type { ToolName } from "@chess-agent/agent-tools";
import type { AgentMessage, AgentModel, ModelResponse } from "./index.js";

interface OllamaToolCall {
  readonly function?: { readonly name?: string; readonly arguments?: unknown };
}

interface OllamaChatResponse {
  readonly message?: {
    readonly content?: string;
    readonly tool_calls?: readonly OllamaToolCall[];
  };
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

interface OllamaMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly tool_calls?: readonly {
    readonly function: { readonly name: string; readonly arguments: unknown };
  }[];
}

export interface OllamaChatModelOptions {
  readonly model?: string;
  readonly baseUrl?: string;
  readonly contextLength?: number;
  readonly fetch?: typeof fetch;
}

/** Local Ollama provider adapter; orchestration and policy remain in AgentRuntime. */
export class OllamaChatModel implements AgentModel {
  readonly #model: string;
  readonly #endpoint: URL;
  readonly #contextLength: number;
  readonly #fetch: typeof fetch;

  constructor(options: OllamaChatModelOptions = {}) {
    this.#model = options.model ?? "qwen3:4b";
    this.#endpoint = new URL("/api/chat", options.baseUrl ?? "http://127.0.0.1:11434");
    this.#contextLength = options.contextLength ?? 8_192;
    this.#fetch = options.fetch ?? fetch;
  }

  async respond({ messages, tools, signal }: Parameters<AgentModel["respond"]>[0]): Promise<ModelResponse> {
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: this.#model,
        messages: toOllamaMessages(messages),
        tools: tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
        })),
        stream: false,
        think: false,
        keep_alive: "10m",
        options: { temperature: 0.2, num_ctx: this.#contextLength }
      }),
      signal
    });
    if (!response.ok) throw new Error(`Local model request failed with status ${response.status}`);
    const value = await response.json() as OllamaChatResponse;
    if (value.message === undefined) throw new Error("Local model returned an invalid response");
    const usage = {
      inputTokens: value.prompt_eval_count ?? 0,
      outputTokens: value.eval_count ?? 0
    };
    const calls = (value.message.tool_calls ?? []).flatMap((call) => {
      const name = call.function?.name;
      if (name === undefined) return [];
      return [{
        id: `ollama_${randomUUID()}`,
        name: name as ToolName,
        arguments: call.function?.arguments ?? {}
      }];
    });
    if (calls.length > 0) return { type: "tool_calls", calls, usage };
    return { type: "final", message: cleanOllamaContent(value.message.content ?? ""), usage };
  }
}

export function cleanOllamaContent(content: string): string {
  const afterThinking = content.includes("</think>") ? content.slice(content.lastIndexOf("</think>") + 8) : content;
  return afterThinking.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export function toOllamaMessages(messages: readonly AgentMessage[]): OllamaMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") return { role: "tool", content: message.content };
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: call.arguments }
        }))
      };
    }
    return { role: message.role, content: message.content };
  });
}
