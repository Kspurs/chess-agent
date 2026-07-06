import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Fen } from "@chess-agent/chess-domain";
import { UciProcessWorker } from "./index.js";

const stockfishPath = process.env.STOCKFISH_PATH;
const runIntegration = process.env.RUN_STOCKFISH_INTEGRATION === "true" && stockfishPath !== undefined;

describe.skipIf(!runIntegration)("Stockfish process integration", () => {
  it("completes a real UCI handshake and analysis", async () => {
    await access(stockfishPath!);
    const worker = await UciProcessWorker.create({ binary: stockfishPath!, threads: 1, hashMb: 16, timeoutMs: 15_000 });
    try {
      const result = await worker.analyze({
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" as Fen,
        depth: 8,
        multiPv: 2
      });
      expect(result.bestMove).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
      expect(result.variations).toHaveLength(2);
      expect(result.depth).toBeGreaterThanOrEqual(8);
    } finally {
      await worker.dispose();
    }
  }, 20_000);
});
