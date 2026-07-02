import { describe, expect, it } from "vitest";
import type { Fen, UciMove } from "@chess-agent/chess-domain";
import type { PuzzleId, UserId } from "@chess-agent/shared-types";
import { InMemoryPuzzleRepository, PuzzleService, type PuzzleRecord } from "./index.js";

const userId = "user_1" as UserId;
const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" as Fen;

describe("PuzzleService", () => {
  it("selects by rating/theme and validates a multi-move solution", async () => {
    const service = createService();
    const { puzzleId } = await service.createPuzzle({ requestedBy: userId, rating: 1_250, theme: "opening" });
    expect(await service.getPuzzle(puzzleId)).toHaveProperty("initialFen");
    expect(await service.getPuzzle(puzzleId)).not.toHaveProperty("solution");
    expect(await service.submitMove(userId, puzzleId, "e2e4")).toMatchObject({
      correct: true,
      complete: false,
      opponentMove: "e7e5"
    });
    expect(service.getHint(userId, puzzleId, 2)).toContain("f3");
    expect(await service.submitMove(userId, puzzleId, "g1f3")).toMatchObject({ correct: true, complete: true });
    expect(service.attemptsFor(userId)[0]).toMatchObject({ solved: true, hintsUsed: 2 });
  });

  it("ends failed attempts without revealing the solution", async () => {
    const service = createService();
    const { puzzleId } = await service.createPuzzle({ requestedBy: userId, theme: "opening" });
    const result = await service.submitMove(userId, puzzleId, "d2d4");
    expect(result).toMatchObject({ correct: false, complete: true });
    expect(result.message).not.toContain("e2e4");
    expect(service.ratingFor(userId)).toBeLessThan(1_200);
  });

  it("avoids recently served puzzles when alternatives exist", async () => {
    const service = createService();
    const first = await service.createPuzzle({ requestedBy: userId });
    const second = await service.createPuzzle({ requestedBy: userId });
    expect(second.puzzleId).not.toBe(first.puzzleId);
  });

  it("requires dataset provenance and legal solution lines", () => {
    const repository = new InMemoryPuzzleRepository();
    expect(() => repository.import([{ ...records[0] as PuzzleRecord, license: "" }])).toThrow(TypeError);
    expect(() => repository.import([{ ...records[0] as PuzzleRecord, solution: ["e2e5" as UciMove] }])).toThrow();
  });
});

function createService(): PuzzleService {
  const repository = new InMemoryPuzzleRepository();
  repository.import(records);
  return new PuzzleService(repository, () => new Date("2026-07-02T00:00:00.000Z"));
}

const records: PuzzleRecord[] = [
  {
    id: "puzzle_1" as PuzzleId,
    initialFen: start,
    solution: ["e2e4", "e7e5", "g1f3"] as UciMove[],
    rating: 1_200,
    themes: ["opening"],
    source: "test fixture",
    license: "CC0"
  },
  {
    id: "puzzle_2" as PuzzleId,
    initialFen: start,
    solution: ["d2d4", "d7d5", "c2c4"] as UciMove[],
    rating: 1_400,
    themes: ["development"],
    source: "test fixture",
    license: "CC0"
  }
];
