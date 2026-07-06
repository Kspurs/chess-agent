import type { GameId, UserId } from "@chess-agent/shared-types";
import { Chess, validateFen } from "chess.js";

export type Color = "white" | "black";
export type GameStatus = "created" | "started" | "checkmate" | "stalemate" | "draw" | "resigned" | "aborted" | "finished";
export type GameResult = "1-0" | "0-1" | "1/2-1/2" | "*";
export type GameMode = "human" | "computer";
export type San = string & { readonly __brand: "San" };
export type UciMove = string & { readonly __brand: "UciMove" };
export type Fen = string & { readonly __brand: "Fen" };
export type Pgn = string & { readonly __brand: "Pgn" };

export interface ChessMove {
  readonly ply: number;
  readonly san: San;
  readonly uci: UciMove;
  readonly fenAfter: Fen;
  readonly playedAt?: string;
}

export interface ChessClock {
  readonly initialMs: number;
  readonly incrementMs: number;
  readonly whiteMs: number;
  readonly blackMs: number;
  readonly running: Color | null;
}

export interface ChessGame {
  readonly id: GameId;
  readonly provider: string;
  readonly variant: string;
  readonly mode: GameMode;
  readonly whiteUserId?: UserId;
  readonly blackUserId?: UserId;
  readonly status: GameStatus;
  readonly result: GameResult;
  readonly currentFen: Fen;
  readonly moves: readonly ChessMove[];
  readonly clock?: ChessClock;
}

export interface LegalMove {
  readonly san: San;
  readonly uci: UciMove;
  readonly from: string;
  readonly to: string;
  readonly promotion?: "q" | "r" | "b" | "n";
}

export interface PositionState {
  readonly fen: Fen;
  readonly turn: Color;
  readonly check: boolean;
  readonly checkmate: boolean;
  readonly stalemate: boolean;
  readonly threefoldRepetition: boolean;
  readonly insufficientMaterial: boolean;
  readonly fiftyMoveDraw: boolean;
  readonly gameOver: boolean;
}

/** Stateful, deterministic rules facade. Persist its FEN/moves, not this object. */
export class ChessRules {
  readonly #chess: Chess;

  constructor(fen?: string) {
    if (fen !== undefined) {
      const validation = validateFen(fen);
      if (!validation.ok) throw new TypeError(validation.error);
    }
    this.#chess = new Chess(fen);
  }

  legalMoves(): readonly LegalMove[] {
    return this.#chess.moves({ verbose: true }).map((move) => {
      const base = {
        san: move.san as San,
        uci: `${move.from}${move.to}${move.promotion ?? ""}` as UciMove,
        from: move.from,
        to: move.to
      };
      return move.promotion === undefined
        ? base
        : { ...base, promotion: move.promotion as "q" | "r" | "b" | "n" };
    });
  }

  makeMove(notation: string): ChessMove {
    const normalized = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(notation)
      ? notation.length === 5
        ? { from: notation.slice(0, 2), to: notation.slice(2, 4), promotion: notation[4] as string }
        : { from: notation.slice(0, 2), to: notation.slice(2, 4) }
      : notation;
    let move;
    try {
      move = this.#chess.move(normalized);
    } catch {
      throw new IllegalMoveError(notation, this.legalMoves());
    }
    const history = this.#chess.history();
    return {
      ply: history.length,
      san: move.san as San,
      uci: `${move.from}${move.to}${move.promotion ?? ""}` as UciMove,
      fenAfter: this.#chess.fen() as Fen
    };
  }

  state(): PositionState {
    return {
      fen: this.#chess.fen() as Fen,
      turn: this.#chess.turn() === "w" ? "white" : "black",
      check: this.#chess.inCheck(),
      checkmate: this.#chess.isCheckmate(),
      stalemate: this.#chess.isStalemate(),
      threefoldRepetition: this.#chess.isThreefoldRepetition(),
      insufficientMaterial: this.#chess.isInsufficientMaterial(),
      fiftyMoveDraw: this.#chess.isDrawByFiftyMoves(),
      gameOver: this.#chess.isGameOver()
    };
  }

  pgn(): Pgn {
    return this.#chess.pgn() as Pgn;
  }
}

export class IllegalMoveError extends Error {
  constructor(
    readonly notation: string,
    readonly legalMoves: readonly LegalMove[]
  ) {
    super(`Illegal or ambiguous move: ${notation}`);
    this.name = "IllegalMoveError";
  }
}

export function parseUciMove(value: unknown): UciMove {
  if (typeof value !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value)) {
    throw new TypeError("invalid UCI move");
  }
  return value as UciMove;
}

export function parseFen(value: unknown): Fen {
  if (typeof value !== "string") throw new TypeError("FEN must be a string");
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 6) throw new TypeError("FEN must contain six fields");
  const ranks = fields[0]?.split("/") ?? [];
  if (ranks.length !== 8 || ranks.some((rank) => !validRank(rank))) {
    throw new TypeError("invalid FEN board field");
  }
  if (fields[1] !== "w" && fields[1] !== "b") throw new TypeError("invalid FEN active color");
  if (!/^(?:-|K?Q?k?q?)$/.test(fields[2] ?? "")) throw new TypeError("invalid FEN castling rights");
  if (!/^(?:-|[a-h][36])$/.test(fields[3] ?? "")) throw new TypeError("invalid FEN en passant square");
  if (!/^\d+$/.test(fields[4] ?? "") || !/^[1-9]\d*$/.test(fields[5] ?? "")) throw new TypeError("invalid FEN counters");
  return value as Fen;
}

export function opposite(color: Color): Color {
  return color === "white" ? "black" : "white";
}

export function validatePgn(value: unknown): Pgn {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("PGN must be a non-empty string");
  try {
    const chess = new Chess();
    chess.loadPgn(value, { strict: false });
  } catch (error) {
    throw new TypeError("invalid PGN", { cause: error });
  }
  return value as Pgn;
}

function validRank(rank: string): boolean {
  if (!/^[prnbqkPRNBQK1-8]+$/.test(rank)) return false;
  let squares = 0;
  for (const token of rank) squares += /\d/.test(token) ? Number(token) : 1;
  return squares === 8;
}
