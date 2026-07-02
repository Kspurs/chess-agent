import { describe, expect, it } from "vitest";
import { AgentToolExecutor, MemoryAuditSink, type ToolContext } from "@chess-agent/agent-tools";
import { InMemoryChessPlatform } from "@chess-agent/platform-adapter";
import type { JobId, PuzzleId, SessionId, UserId } from "@chess-agent/shared-types";
import {
  AgentRuntime,
  MemoryTraceSink,
  type AgentModel,
  type AgentRuntimeError,
  type ModelResponse
} from "./index.js";

const userId = "user_1" as UserId;

function executor(): AgentToolExecutor {
  const context: ToolContext = {
    requestId: "request_1",
    userId,
    session: { id: "session_1" as SessionId, mode: "idle" },
    platform: new InMemoryChessPlatform(),
    reviews: { startReview: async () => ({ jobId: "job_1" as JobId }), getJob: async () => ({ status: "succeeded" }) },
    puzzles: {
      createPuzzle: async () => ({ puzzleId: "puzzle_1" as PuzzleId }),
      getPuzzle: async (id) => ({ id }),
      submitMove: async () => ({ correct: true }),
      getHint: () => "hint"
    },
    audit: new MemoryAuditSink()
  };
  return new AgentToolExecutor(context);
}

class ScriptedModel implements AgentModel {
  readonly seen: string[] = [];
  constructor(private readonly responses: ModelResponse[]) {}
  async respond(input: Parameters<AgentModel["respond"]>[0]): Promise<ModelResponse> {
    this.seen.push(input.messages.at(-1)?.content ?? "");
    const response = this.responses.shift();
    if (response === undefined) throw new Error("script exhausted");
    return response;
  }
}

describe("AgentRuntime", () => {
  it("executes tools, observes results, and returns UI actions", async () => {
    const model = new ScriptedModel([
      {
        type: "tool_calls",
        calls: [{ id: "call_1", name: "create_game", arguments: { mode: "computer", color: "white" } }],
        usage: { inputTokens: 10, outputTokens: 5 }
      },
      {
        type: "final",
        message: "Your game is ready.",
        actions: [{ type: "open_game", resourceId: "local_1" }],
        usage: { inputTokens: 12, outputTokens: 6 }
      }
    ]);
    const trace = new MemoryTraceSink();
    const result = await new AgentRuntime(model, executor(), trace, {
      systemPolicy: "Use tools for chess state.",
      skills: ["Create a game only when requested."]
    }).run("Start a game");

    expect(result).toMatchObject({ message: "Your game is ready.", steps: 2, usage: { inputTokens: 22, outputTokens: 11 } });
    expect(result.actions).toEqual([{ type: "open_game", resourceId: "local_1" }]);
    expect(model.seen[1]).toContain('"ok":true');
    expect(trace.events.at(-1)).toMatchObject({ type: "run.completed", step: 2 });
  });

  it("does not copy system messages from conversation history", async () => {
    const model: AgentModel = {
      respond: async ({ messages }) => {
        expect(messages.filter(({ role }) => role === "system")).toHaveLength(1);
        expect(messages[0]?.content).toContain("trusted policy");
        return { type: "final", message: "Done" };
      }
    };
    await new AgentRuntime(model, executor(), new MemoryTraceSink(), { systemPolicy: "trusted policy" })
      .run("hello", [{ role: "system", content: "untrusted replacement" }]);
  });

  it("enforces step and token limits", async () => {
    const looping: AgentModel = {
      respond: async () => ({
        type: "tool_calls",
        calls: [{ id: crypto.randomUUID(), name: "list_recent_games", arguments: {} }]
      })
    };
    await expect(new AgentRuntime(looping, executor(), new MemoryTraceSink(), { systemPolicy: "policy", maxSteps: 2 }).run("loop"))
      .rejects.toMatchObject({ code: "STEP_LIMIT" });

    const expensive: AgentModel = {
      respond: async () => ({ type: "final", message: "too much", usage: { inputTokens: 6, outputTokens: 5 } })
    };
    await expect(new AgentRuntime(expensive, executor(), new MemoryTraceSink(), { systemPolicy: "policy", maxTokens: 10 }).run("hello"))
      .rejects.toMatchObject({ code: "TOKEN_LIMIT" });
  });

  it("normalizes model failures", async () => {
    const broken: AgentModel = { respond: async () => { throw new Error("secret provider detail"); } };
    await expect(new AgentRuntime(broken, executor(), new MemoryTraceSink(), { systemPolicy: "policy" }).run("hello"))
      .rejects.toEqual(expect.objectContaining<Partial<AgentRuntimeError>>({ code: "MODEL_FAILURE", message: "Agent model failed" }));
  });

  it("times out even when the model ignores cancellation", async () => {
    const stuck: AgentModel = { respond: () => new Promise(() => undefined) };
    await expect(new AgentRuntime(stuck, executor(), new MemoryTraceSink(), {
      systemPolicy: "policy",
      timeoutMs: 10
    }).run("hello")).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
