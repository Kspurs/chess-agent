import { describe, expect, it } from "vitest";
import { InMemoryChessPlatform } from "@chess-agent/platform-adapter";
import type { GameId, JobId, PuzzleId, SessionId, UserId } from "@chess-agent/shared-types";
import { AgentToolExecutor, MemoryAuditSink, TOOL_DESCRIPTORS, type ToolContext } from "./index.js";

const userId = "user_1" as UserId;

function context(platform = new InMemoryChessPlatform()): ToolContext {
  return {
    requestId: "request_1",
    userId,
    session: { id: "session_1" as SessionId, mode: "idle" },
    platform,
    reviews: { startReview: async () => ({ jobId: "job_1" as JobId }), getJob: async () => ({ status: "succeeded" }) },
    puzzles: {
      createPuzzle: async () => ({ puzzleId: "puzzle_1" as PuzzleId }),
      getPuzzle: async (id) => ({ id, initialFen: "fen" }),
      submitMove: async () => ({ correct: true, complete: true }),
      getHint: () => "Look for a forcing move."
    },
    audit: new MemoryAuditSink(),
    now: () => new Date("2026-07-02T00:00:00.000Z")
  };
}

describe("AgentToolExecutor", () => {
  it("publishes strict schemas for every tool", () => {
    expect(TOOL_DESCRIPTORS).toHaveLength(9);
    for (const tool of TOOL_DESCRIPTORS) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.inputSchema).toHaveProperty("properties");
    }
  });

  it("validates arguments and creates games idempotently", async () => {
    const ctx = context();
    const executor = new AgentToolExecutor(ctx);
    const call = { id: "call_1", name: "create_game" as const, arguments: { mode: "computer", color: "white" } };
    const first = await executor.execute(call);
    const second = await executor.execute(call);
    expect(first).toMatchObject({ ok: true });
    expect((second as { value: { game: { id: string } } }).value.game.id)
      .toBe((first as { value: { game: { id: string } } }).value.game.id);
  });

  it("normalizes invalid input and writes an audit record", async () => {
    const ctx = context();
    const result = await new AgentToolExecutor(ctx).execute({ id: "call_2", name: "create_game", arguments: { mode: "robot", color: "white" } });
    expect(result).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    expect((ctx.audit as MemoryAuditSink).records).toEqual([
      expect.objectContaining({ callId: "call_2", success: false, errorCode: "BAD_REQUEST" })
    ]);
  });

  it("allows only the player's turn", async () => {
    const platform = new InMemoryChessPlatform();
    const created = await platform.createGame({ requesterUserId: userId, mode: "computer", color: "white" }, "seed");
    const executor = new AgentToolExecutor(context(platform));
    const first = await executor.execute({ id: "call_3", name: "make_move", arguments: { gameId: created.game.id, move: "e4", expectedRevision: 0 } });
    expect(first).toMatchObject({ ok: true });
    const second = await executor.execute({ id: "call_4", name: "make_move", arguments: { gameId: created.game.id, move: "e5", expectedRevision: 1 } });
    expect(second).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("blocks analysis capabilities during active human games", async () => {
    const platform = new InMemoryChessPlatform();
    const created = await platform.createGame({ requesterUserId: userId, mode: "human", color: "white" }, "seed");
    const base = context(platform);
    const ctx: ToolContext = {
      ...base,
      session: { ...base.session, mode: "playing", activeGameId: created.game.id }
    };
    const result = await new AgentToolExecutor(ctx).execute({ id: "call_5", name: "create_puzzle", arguments: {} });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("prevents access to another user's game", async () => {
    const platform = new InMemoryChessPlatform();
    const other = "other" as UserId;
    const created = await platform.createGame({ requesterUserId: other, mode: "human", color: "white" }, "other-seed");
    const result = await new AgentToolExecutor(context(platform)).execute({ id: "call_6", name: "get_game", arguments: { gameId: created.game.id as GameId } });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("closes the puzzle play and hint workflows within the active session", async () => {
    const base = context();
    const ctx: ToolContext = {
      ...base,
      session: { id: base.session.id, mode: "puzzle", activePuzzleId: "puzzle_1" as PuzzleId }
    };
    const executor = new AgentToolExecutor(ctx);
    await expect(executor.execute({ id: "move", name: "submit_puzzle_move", arguments: { puzzleId: "puzzle_1", move: "e2e4" } }))
      .resolves.toMatchObject({ ok: true, value: { correct: true } });
    await expect(executor.execute({ id: "hint", name: "get_puzzle_hint", arguments: { puzzleId: "puzzle_1", level: 1 } }))
      .resolves.toMatchObject({ ok: true, value: { hint: "Look for a forcing move." } });
  });
});
