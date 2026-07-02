import { describe, expect, it } from "vitest";
import { fenToBoard } from "./index.js";

describe("web chess utilities", () => {
  it("expands FEN into 64 board squares", () => {
    const board = fenToBoard("8/8/8/3k4/8/8/4K3/8 w - - 0 1");
    expect(board).toHaveLength(8);
    expect(board.flat()).toHaveLength(64);
    expect(board[3]?.[3]).toBe("k");
    expect(board[6]?.[4]).toBe("K");
  });
});

