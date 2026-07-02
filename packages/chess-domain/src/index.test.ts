import { describe, expect, it } from "vitest";
import { ChessRules, IllegalMoveError, opposite, parseFen, parseUciMove } from "./index.js";

describe("chess value parsing", () => {
  it("accepts valid UCI moves and FEN values", () => {
    expect(parseUciMove("e7e8q")).toBe("e7e8q");
    expect(parseFen("8/8/8/8/8/8/8/8 w - - 0 1")).toContain(" w ");
  });

  it("rejects malformed values", () => {
    expect(() => parseUciMove("e9e4")).toThrow(TypeError);
    expect(() => parseFen("8/8/8 w - - 0 1")).toThrow(TypeError);
  });

  it("returns the opposite color", () => {
    expect(opposite("white")).toBe("black");
    expect(opposite("black")).toBe("white");
  });
});

describe("authoritative chess rules", () => {
  it("plays legal SAN and UCI moves", () => {
    const chess = new ChessRules();
    expect(chess.makeMove("e2e4").san).toBe("e4");
    expect(chess.makeMove("e5").uci).toBe("e7e5");
    expect(chess.state().turn).toBe("white");
  });

  it("rejects illegal moves with legal alternatives", () => {
    const chess = new ChessRules();
    expect(() => chess.makeMove("e2e5")).toThrow(IllegalMoveError);
    try {
      chess.makeMove("e2e5");
    } catch (error) {
      expect((error as IllegalMoveError).legalMoves.length).toBe(20);
    }
  });

  it("handles castling and promotion", () => {
    const castling = new ChessRules("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    expect(castling.makeMove("O-O").uci).toBe("e1g1");

    const promotion = new ChessRules("8/P6k/8/8/8/8/7K/8 w - - 0 1");
    expect(promotion.makeMove("a7a8q").san).toContain("=Q");
  });

  it("recognizes checkmate", () => {
    const chess = new ChessRules();
    chess.makeMove("f3");
    chess.makeMove("e5");
    chess.makeMove("g4");
    chess.makeMove("Qh4#");
    expect(chess.state()).toMatchObject({ check: true, checkmate: true, gameOver: true });
  });
});
