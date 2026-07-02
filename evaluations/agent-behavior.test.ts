import { describe, expect, it } from "vitest";
import { AgentRuntime, MemoryTraceSink, type AgentModel } from "@chess-agent/agent-runtime";
import { AgentToolExecutor, MemoryAuditSink, type ToolContext } from "@chess-agent/agent-tools";
import { ChessRules, IllegalMoveError } from "@chess-agent/chess-domain";
import { InMemoryChessPlatform } from "@chess-agent/platform-adapter";
import type { JobId, PuzzleId, SessionId, UserId } from "@chess-agent/shared-types";

const userId = "eval_user" as UserId;

describe("agent behavior evaluations", () => {
  it("does not guess ambiguous SAN", () => {
    const position = new ChessRules("4k3/8/8/8/8/2N1N3/8/4K3 w - - 0 1");
    expect(() => position.makeMove("Nd5")).toThrow(IllegalMoveError);
  });

  it("recovers from a failed tool observation", async () => {
    let turn = 0;
    const model: AgentModel = {
      respond: async ({ messages }) => {
        turn += 1;
        if (turn === 1) return { type: "tool_calls", calls: [{ id: "bad", name: "make_move", arguments: { gameId: "missing", move: "e4", expectedRevision: 0 } }] };
        expect(messages.at(-1)?.content).toContain('"ok":false');
        return { type: "final", message: "I couldn't find that game. Which game did you mean?" };
      }
    };
    const result = await new AgentRuntime(model, executor(), new MemoryTraceSink(), { systemPolicy: "Use tools." })
      .run("Play e4");
    expect(result.message).toContain("Which game");
  });

  it("denies puzzle assistance during a live human game", async () => {
    const platform = new InMemoryChessPlatform();
    const game = await platform.createGame({ requesterUserId: userId, mode: "human", color: "white" }, "eval-game");
    const tools = executor(platform, { id: "eval_session" as SessionId, mode: "playing", activeGameId: game.game.id });
    const result = await tools.execute({ id: "puzzle", name: "create_puzzle", arguments: {} });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});

function executor(
  platform = new InMemoryChessPlatform(),
  session: ToolContext["session"] = { id: "eval_session" as SessionId, mode: "idle" }
): AgentToolExecutor {
  return new AgentToolExecutor({
    requestId: "eval_request",
    userId,
    session,
    platform,
    reviews: { startReview: async () => ({ jobId: "job" as JobId }), getJob: async () => ({ status: "succeeded" }) },
    puzzles: {
      createPuzzle: async () => ({ puzzleId: "puzzle" as PuzzleId }),
      getPuzzle: async (id) => ({ id }),
      submitMove: async () => ({ correct: true }),
      getHint: () => "hint"
    },
    audit: new MemoryAuditSink()
  });
}
