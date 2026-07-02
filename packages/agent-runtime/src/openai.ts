import OpenAI from "openai";
import type { ResponseInputItem, Tool } from "openai/resources/responses/responses";
import type { ToolName } from "@chess-agent/agent-tools";
import type {
  AgentMessage,
  AgentModel,
  ModelResponse
} from "./index.js";

export interface OpenAIResponsesModelOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  readonly client?: Pick<OpenAI, "responses">;
}

/** Provider adapter only; orchestration remains in AgentRuntime. */
export class OpenAIResponsesModel implements AgentModel {
  readonly #client: Pick<OpenAI, "responses">;
  readonly #model: string;
  readonly #reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh";

  constructor(options: OpenAIResponsesModelOptions = {}) {
    this.#client = options.client ?? new OpenAI({ apiKey: options.apiKey });
    this.#model = options.model ?? "gpt-5.4-mini";
    this.#reasoningEffort = options.reasoningEffort ?? "low";
  }

  async respond({ messages, tools, signal }: Parameters<AgentModel["respond"]>[0]): Promise<ModelResponse> {
    const response = await this.#client.responses.create({
      model: this.#model,
      input: toResponseInput(messages),
      tools: tools.map<Tool>((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: true
      })),
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: this.#reasoningEffort }
    }, { signal });

    const usage = {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0
    };
    const calls = response.output
      .filter((item) => item.type === "function_call")
      .map((item) => ({
        id: item.call_id,
        name: item.name as ToolName,
        arguments: parseArguments(item.arguments)
      }));
    if (calls.length > 0) return { type: "tool_calls", calls, usage };
    return { type: "final", message: response.output_text, usage };
  }
}

export function toResponseInput(messages: readonly AgentMessage[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      if (message.content.length > 0) input.push({ role: "assistant", content: message.content });
      for (const call of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments)
        });
      }
      continue;
    }
    input.push({ role: message.role, content: message.content });
  }
  return input;
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

