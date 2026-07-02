import { describe, expect, it } from "vitest";
import type { GameId, UserId } from "@chess-agent/shared-types";
import { InMemoryChessPlatform, PlatformError } from "./index.js";

const userId = "user_1" as UserId;

describe("ChessPlatform contract", () => {
  it("creates games idempotently and lists them", async () => {
    const platform = new InMemoryChessPlatform();
    const options = { requesterUserId: userId, mode: "computer" as const, color: "white" as const };
    const first = await platform.createGame(options, "request_1");
    const repeated = await platform.createGame(options, "request_1");
    expect(repeated.game.id).toBe(first.game.id);
    expect((await platform.listRecentGames(userId, { limit: 10 })).items).toHaveLength(1);
  });

  it("applies moves with optimistic concurrency", async () => {
    const platform = new InMemoryChessPlatform();
    const created = await platform.createGame({ requesterUserId: userId, mode: "computer", color: "white" }, "request_2");
    const moved = await platform.makeMove(created.game.id, "e4", 0);
    expect(moved.revision).toBe(1);
    expect(moved.game.moves[0]?.uci).toBe("e2e4");
    await expect(platform.makeMove(created.game.id, "e5", 0)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("normalizes missing, illegal, and unauthorized operations", async () => {
    const platform = new InMemoryChessPlatform();
    await expect(platform.getGame("missing" as GameId)).rejects.toBeInstanceOf(PlatformError);
    const created = await platform.createGame({ requesterUserId: userId, mode: "human", color: "white" }, "request_3");
    await expect(platform.makeMove(created.game.id, "e5", 0)).rejects.toMatchObject({ code: "ILLEGAL_MOVE" });
    await expect(platform.resign(created.game.id, "stranger" as UserId, 0)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

