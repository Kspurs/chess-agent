import {
  TOOL_DESCRIPTORS,
  type ToolCall,
  type ToolDescriptor,
  type ToolResult
} from "@chess-agent/agent-tools";
import type { AgentToolExecutor } from "@chess-agent/agent-tools";

export type AgentMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: "tool"; readonly toolCallId: string; readonly name: string; readonly content: string };

export interface AgentUiAction {
  readonly type: "open_game" | "open_review" | "open_puzzle" | "highlight_squares";
  readonly resourceId?: string;
  readonly squares?: readonly string[];
}

export type ModelResponse =
  | {
      readonly type: "final";
      readonly message: string;
      readonly actions?: readonly AgentUiAction[];
      readonly usage?: ModelUsage;
    }
  | {
      readonly type: "tool_calls";
      readonly calls: readonly ToolCall[];
      readonly usage?: ModelUsage;
    };

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AgentModel {
  respond(input: {
    readonly messages: readonly AgentMessage[];
    readonly tools: readonly ToolDescriptor[];
    readonly signal: AbortSignal;
  }): Promise<ModelResponse>;
}

export interface AgentTraceEvent {
  readonly type: "model.started" | "model.completed" | "tool.started" | "tool.completed" | "run.completed" | "run.failed";
  readonly step: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly success?: boolean;
  readonly errorCode?: string;
}

export interface TraceSink {
  write(event: AgentTraceEvent): Promise<void>;
}

export interface AgentRuntimeOptions {
  readonly maxSteps?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly systemPolicy: string;
  readonly skills?: readonly string[];
}

export interface AgentRunResult {
  readonly message: string;
  readonly actions: readonly AgentUiAction[];
  readonly steps: number;
  readonly usage: ModelUsage;
  readonly messages: readonly AgentMessage[];
}

export class AgentRuntime {
  readonly #maxSteps: number;
  readonly #maxTokens: number;
  readonly #timeoutMs: number;

  constructor(
    private readonly model: AgentModel,
    private readonly tools: AgentToolExecutor,
    private readonly trace: TraceSink,
    private readonly options: AgentRuntimeOptions
  ) {
    this.#maxSteps = positiveInteger(options.maxSteps ?? 8, "maxSteps");
    this.#maxTokens = positiveInteger(options.maxTokens ?? 16_000, "maxTokens");
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, "timeoutMs");
  }

  async run(userMessage: string, history: readonly AgentMessage[] = []): Promise<AgentRunResult> {
    if (userMessage.trim().length === 0) throw new AgentRuntimeError("INVALID_REQUEST", "User message cannot be empty");
    const messages: AgentMessage[] = [
      { role: "system", content: assembleInstructions(this.options.systemPolicy, this.options.skills ?? []) },
      ...history.filter((message) => message.role !== "system"),
      { role: "user", content: userMessage }
    ];
    const usage = { inputTokens: 0, outputTokens: 0 };
    const inferredActions: AgentUiAction[] = [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("agent run timed out")), this.#timeoutMs);
    let currentStep = 0;

    try {
      for (let step = 1; step <= this.#maxSteps; step += 1) {
        currentStep = step;
        await this.trace.write({ type: "model.started", step });
        const response = await withAbort(
          this.model.respond({ messages, tools: TOOL_DESCRIPTORS, signal: controller.signal }),
          controller.signal
        );
        addUsage(usage, response.usage);
        if (usage.inputTokens + usage.outputTokens > this.#maxTokens) {
          throw new AgentRuntimeError("TOKEN_LIMIT", "Agent exceeded its token budget");
        }
        await this.trace.write({ type: "model.completed", step });

        if (response.type === "final") {
          messages.push({ role: "assistant", content: response.message });
          await this.trace.write({ type: "run.completed", step });
          return {
            message: response.message,
            actions: uniqueActions([...inferredActions, ...(response.actions ?? [])]),
            steps: step,
            usage,
            messages
          };
        }

        if (response.calls.length === 0) throw new AgentRuntimeError("INVALID_MODEL_OUTPUT", "Model returned no tool calls");
        messages.push({
          role: "assistant",
          content: "",
          toolCalls: response.calls
        });
        for (const call of response.calls) {
          await this.trace.write({ type: "tool.started", step, toolCallId: call.id, toolName: call.name });
          const result = await withAbort(this.tools.execute(call), controller.signal);
          if (result.ok) {
            const inferred = inferAction(call.name, result.value);
            if (inferred !== undefined) inferredActions.push(inferred);
          }
          await this.trace.write({
            type: "tool.completed",
            step,
            toolCallId: call.id,
            toolName: call.name,
            success: result.ok,
            ...(result.ok ? {} : { errorCode: result.error.code })
          });
          messages.push(toolMessage(call, result));
        }
      }
      throw new AgentRuntimeError("STEP_LIMIT", "Agent exceeded its maximum number of steps");
    } catch (error) {
      const normalized = controller.signal.aborted
        ? new AgentRuntimeError("TIMEOUT", "Agent run timed out")
        : error instanceof AgentRuntimeError
          ? error
          : new AgentRuntimeError("MODEL_FAILURE", "Agent model failed", { cause: error });
      await this.trace.write({ type: "run.failed", step: currentStep, errorCode: normalized.code });
      throw normalized;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export * from "./openai.js";
export * from "./ollama.js";


export type AgentRuntimeErrorCode = "INVALID_REQUEST" | "INVALID_MODEL_OUTPUT" | "STEP_LIMIT" | "TOKEN_LIMIT" | "TIMEOUT" | "MODEL_FAILURE";

export class AgentRuntimeError extends Error {
  constructor(readonly code: AgentRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRuntimeError";
  }
}

export class MemoryTraceSink implements TraceSink {
  readonly events: AgentTraceEvent[] = [];
  async write(event: AgentTraceEvent): Promise<void> {
    this.events.push(event);
  }
}

function assembleInstructions(policy: string, skills: readonly string[]): string {
  return [policy.trim(), ...skills.map((skill, index) => `Skill ${index + 1}:\n${skill.trim()}`)]
    .filter(Boolean)
    .join("\n\n");
}

function addUsage(total: { inputTokens: number; outputTokens: number }, usage?: ModelUsage): void {
  if (usage === undefined) return;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
}

function toolMessage(call: ToolCall, result: ToolResult): AgentMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: JSON.stringify(result)
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function inferAction(tool: ToolCall["name"], value: unknown): AgentUiAction | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if ((tool === "create_game" || tool === "get_game" || tool === "make_move") &&
      typeof record.game === "object" && record.game !== null &&
      typeof (record.game as Record<string, unknown>).id === "string") {
    return { type: "open_game", resourceId: (record.game as Record<string, unknown>).id as string };
  }
  if (tool === "create_puzzle" && typeof record.puzzleId === "string") return { type: "open_puzzle", resourceId: record.puzzleId };
  if (tool === "get_review" && record.status === "succeeded" && typeof record.result === "object" && record.result !== null &&
      typeof (record.result as Record<string, unknown>).id === "string") {
    return { type: "open_review", resourceId: (record.result as Record<string, unknown>).id as string };
  }
  return undefined;
}

function uniqueActions(actions: readonly AgentUiAction[]): AgentUiAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = JSON.stringify(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}
