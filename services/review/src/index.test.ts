import { describe, expect, it, vi } from "vitest";
import type { Fen, UciMove } from "@chess-agent/chess-domain";
import { InMemoryChessPlatform } from "@chess-agent/platform-adapter";
import type { EngineAnalysis, EngineService } from "@chess-agent/engine";
import type { Job, JobId, UserId } from "@chess-agent/shared-types";
import { GameReviewService, type ReviewArtifact } from "./index.js";

const userId = "user_1" as UserId;

describe("GameReviewService", () => {
  it("analyzes completed games and selects grounded critical moments", async () => {
    const platform = new InMemoryChessPlatform();
    const created = await platform.createGame({ requesterUserId: userId, mode: "computer", color: "white" }, "game");
    await platform.makeMove(created.game.id, "e4", 0);
    await platform.makeMove(created.game.id, "e5", 1);
    await platform.resign(created.game.id, userId, 2);

    const review = new GameReviewService(platform, immediateEngine([250, 0, -20]), {
      depth: 16,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      now: () => new Date("2026-07-02T00:00:00.000Z")
    });
    const submitted = await review.startReview(created.game.id, userId);
    await vi.waitFor(async () => expect((await review.getJob(submitted.jobId)).status).toBe("succeeded"));
    const job = await review.getJob(submitted.jobId) as Job<ReviewArtifact>;
    expect(job.result).toMatchObject({
      gameId: created.game.id,
      engineDepth: 16,
      analyzedPositions: 3,
      criticalMoments: [{ ply: 1, classification: "blunder", lossCentipawns: 250 }]
    });
    expect(job.result?.criticalMoments[0]?.bestLine).toEqual(["e2e4"]);
  });

  it("rejects active games", async () => {
    const platform = new InMemoryChessPlatform();
    const created = await platform.createGame({ requesterUserId: userId, mode: "computer", color: "white" }, "active");
    const review = new GameReviewService(platform, immediateEngine([0]), { pollIntervalMs: 0, sleep: async () => undefined });
    const submitted = await review.startReview(created.game.id, userId);
    await vi.waitFor(async () => expect((await review.getJob(submitted.jobId)).status).toBe("failed"));
    expect(await review.getJob(submitted.jobId)).toMatchObject({ error: { message: "Only completed games can be reviewed" } });
  });
});

function immediateEngine(scores: readonly number[]): EngineService {
  const jobs = new Map<JobId, Job<EngineAnalysis>>();
  let index = 0;
  return {
    submit: async ({ fen, depth }) => {
      const id = `engine_${index}` as JobId;
      const score = scores[index] ?? 0;
      index += 1;
      jobs.set(id, {
        id,
        status: "succeeded",
        progress: 100,
        result: analysis(fen, depth, score)
      });
      return { jobId: id };
    },
    getJob: async (id) => jobs.get(id) as Job<EngineAnalysis>
  };
}

function analysis(fen: Fen, depth: number, score: number): EngineAnalysis {
  return {
    fen,
    perspective: fen.split(" ")[1] === "w" ? "white" : "black",
    depth,
    bestMove: "e2e4" as UciMove,
    variations: [{
      rank: 1,
      depth,
      score: { type: "centipawn", value: score },
      moves: ["e2e4" as UciMove]
    }]
  };
}

