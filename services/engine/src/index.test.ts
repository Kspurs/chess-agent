import { describe, expect, it, vi } from "vitest";
import type { Fen, UciMove } from "@chess-agent/chess-domain";
import {
  StockfishAnalysisService,
  parseUciAnalysis,
  type AnalysisRequest,
  type AnalysisWorker,
  type EngineAnalysis
} from "./index.js";

const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" as Fen;
const request: AnalysisRequest = { fen, depth: 18, multiPv: 2 };

describe("UCI analysis parsing", () => {
  it("parses centipawn, mate, MultiPV, and bestmove output", () => {
    const result = parseUciAnalysis(request, [
      "info depth 17 multipv 1 score cp 31 nodes 100 pv e2e4 e7e5",
      "info depth 18 multipv 1 score cp 35 nodes 200 pv e2e4 e7e5 g1f3",
      "info depth 18 multipv 2 score mate 4 nodes 180 pv d2d4 d7d5",
      "bestmove e2e4 ponder e7e5"
    ]);
    expect(result).toMatchObject({ depth: 18, perspective: "white", bestMove: "e2e4" });
    expect(result.variations).toEqual([
      expect.objectContaining({ rank: 1, score: { type: "centipawn", value: 35 } }),
      expect.objectContaining({ rank: 2, score: { type: "mate", value: 4 } })
    ]);
  });
});

describe("StockfishAnalysisService", () => {
  it("bounds concurrency and caches identical analysis", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const worker: AnalysisWorker = {
      analyze: async (input) => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return analysis(input);
      }
    };
    const service = new StockfishAnalysisService([worker]);
    const first = await service.submit(request);
    const second = await service.submit({ ...request, depth: 17 });
    await vi.waitFor(async () => expect((await service.getJob(first.jobId)).status).toBe("succeeded"));
    await vi.waitFor(async () => expect((await service.getJob(second.jobId)).status).toBe("succeeded"));
    expect(maxActive).toBe(1);

    const cached = await service.submit(request);
    await vi.waitFor(async () => expect((await service.getJob(cached.jobId)).status).toBe("succeeded"));
    expect(calls).toBe(2);
  });

  it("validates limits and normalizes worker failures", async () => {
    const service = new StockfishAnalysisService([{ analyze: async () => { throw new Error("process detail"); } }]);
    await expect(service.submit({ ...request, depth: 31 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const submitted = await service.submit(request);
    await vi.waitFor(async () => expect((await service.getJob(submitted.jobId)).status).toBe("failed"));
    expect(await service.getJob(submitted.jobId)).toMatchObject({ error: { message: "Stockfish analysis failed" } });
  });
});

function analysis(input: AnalysisRequest): EngineAnalysis {
  return {
    fen: input.fen,
    perspective: "white",
    depth: input.depth,
    variations: [{
      rank: 1,
      depth: input.depth,
      score: { type: "centipawn", value: 20 },
      moves: ["e2e4" as UciMove]
    }],
    bestMove: "e2e4" as UciMove
  };
}

