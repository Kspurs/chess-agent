import {
  ChessRules,
  type ChessGame,
  type Color,
  type Fen,
  type GameMode,
  type Pgn
} from "@chess-agent/chess-domain";
import type { GameId, Page, PageRequest, UserId } from "@chess-agent/shared-types";

export interface CreateGameOptions {
  readonly requesterUserId: UserId;
  readonly mode: GameMode;
  readonly color: Color;
  readonly initialMs?: number;
  readonly incrementMs?: number;
  readonly computerLevel?: number;
  readonly opponentUsername?: string;
  readonly rated?: boolean;
  readonly daysPerTurn?: number;
}

export interface VersionedGame {
  readonly game: ChessGame;
  readonly revision: number;
}

export interface GameSyncUpdate {
  readonly gameId: GameId;
  readonly revision: number;
  readonly fen: Fen;
  readonly lastMove?: string;
  readonly moves: readonly { readonly san: string; readonly uci: string }[];
  readonly status: ChessGame["status"];
  readonly result: ChessGame["result"];
  readonly whiteMs?: number;
  readonly blackMs?: number;
  readonly running?: Color | null;
}

export interface ChessPlatform {
  createGame(options: CreateGameOptions, idempotencyKey: string): Promise<VersionedGame>;
  getGame(gameId: GameId): Promise<VersionedGame>;
  listRecentGames(userId: UserId, page: PageRequest): Promise<Page<VersionedGame>>;
  makeMove(gameId: GameId, move: string, expectedRevision: number): Promise<VersionedGame>;
  resign(gameId: GameId, userId: UserId, expectedRevision: number): Promise<VersionedGame>;
  offerDraw(gameId: GameId, userId: UserId, expectedRevision: number): Promise<VersionedGame>;
  respondToDraw(gameId: GameId, userId: UserId, accept: boolean, expectedRevision: number): Promise<VersionedGame>;
  cancelChallenge(gameId: GameId, userId: UserId): Promise<void>;
  requestRematch(gameId: GameId, userId: UserId): Promise<void>;
  exportPgn(gameId: GameId): Promise<Pgn>;
  watchGame?(gameId: GameId, onUpdate: (update: GameSyncUpdate) => void, signal: AbortSignal): Promise<void>;
}

export type PlatformErrorCode = "NOT_FOUND" | "CONFLICT" | "ILLEGAL_MOVE" | "FORBIDDEN" | "INVALID_STATE";

export class PlatformError extends Error {
  constructor(
    readonly code: PlatformErrorCode,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

interface StoredGame {
  value: VersionedGame;
  rules: ChessRules;
  pgn: Pgn;
}

/** Deterministic adapter for local development and provider contract tests. */
export class InMemoryChessPlatform implements ChessPlatform {
  readonly #games = new Map<GameId, StoredGame>();
  readonly #idempotency = new Map<string, GameId>();
  #nextId = 1;

  async createGame(options: CreateGameOptions, idempotencyKey: string): Promise<VersionedGame> {
    const existingId = this.#idempotency.get(idempotencyKey);
    if (existingId !== undefined) return this.getGame(existingId);

    const rules = new ChessRules();
    const id = `local_${this.#nextId++}` as GameId;
    const isWhite = options.color === "white";
    const game: ChessGame = {
      id,
      provider: "memory",
      variant: "standard",
      mode: options.mode,
      ...(isWhite ? { whiteUserId: options.requesterUserId } : { blackUserId: options.requesterUserId }),
      status: "started",
      result: "*",
      currentFen: rules.state().fen,
      moves: [],
      ...(options.initialMs === undefined
        ? {}
        : {
            clock: {
              initialMs: options.initialMs,
              incrementMs: options.incrementMs ?? 0,
              whiteMs: options.initialMs,
              blackMs: options.initialMs,
              running: "white" as const
            }
          })
    };
    const value = { game, revision: 0 };
    this.#games.set(id, { value, rules, pgn: "" as Pgn });
    this.#idempotency.set(idempotencyKey, id);
    return value;
  }

  async getGame(gameId: GameId): Promise<VersionedGame> {
    return this.#require(gameId).value;
  }

  async listRecentGames(userId: UserId, page: PageRequest): Promise<Page<VersionedGame>> {
    const offset = page.cursor === undefined ? 0 : Number.parseInt(page.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new PlatformError("INVALID_STATE", "invalid cursor");
    const matches = [...this.#games.values()]
      .map(({ value }) => value)
      .filter(({ game }) => game.whiteUserId === userId || game.blackUserId === userId)
      .reverse();
    const items = matches.slice(offset, offset + page.limit);
    const nextOffset = offset + items.length;
    return nextOffset < matches.length ? { items, nextCursor: String(nextOffset) } : { items };
  }

  async makeMove(gameId: GameId, move: string, expectedRevision: number): Promise<VersionedGame> {
    const stored = this.#require(gameId);
    this.#assertRevision(stored, expectedRevision);
    if (stored.value.game.status !== "started") throw new PlatformError("INVALID_STATE", "game is not active");
    let played;
    try {
      played = stored.rules.makeMove(move);
    } catch {
      throw new PlatformError("ILLEGAL_MOVE", `illegal or ambiguous move: ${move}`);
    }
    const state = stored.rules.state();
    const status = state.checkmate ? "checkmate" : state.stalemate ? "stalemate" : state.gameOver ? "draw" : "started";
    const result = state.checkmate
      ? state.turn === "white" ? "0-1" : "1-0"
      : state.gameOver ? "1/2-1/2" : "*";
    const game: ChessGame = {
      ...stored.value.game,
      status,
      result,
      currentFen: state.fen,
      moves: [...stored.value.game.moves, played]
    };
    stored.value = { game, revision: stored.value.revision + 1 };
    stored.pgn = stored.rules.pgn();
    return stored.value;
  }

  async resign(gameId: GameId, userId: UserId, expectedRevision: number): Promise<VersionedGame> {
    const stored = this.#require(gameId);
    this.#assertRevision(stored, expectedRevision);
    const { game } = stored.value;
    if (game.status !== "started") throw new PlatformError("INVALID_STATE", "game is not active");
    if (game.whiteUserId !== userId && game.blackUserId !== userId) throw new PlatformError("FORBIDDEN", "user is not a player");
    const result = game.whiteUserId === userId ? "0-1" : "1-0";
    stored.value = { game: { ...game, status: "resigned", result }, revision: stored.value.revision + 1 };
    return stored.value;
  }

  async offerDraw(gameId: GameId, userId: UserId, expectedRevision: number): Promise<VersionedGame> {
    const stored = this.#require(gameId);
    this.#assertRevision(stored, expectedRevision);
    if (stored.value.game.status !== "started") throw new PlatformError("INVALID_STATE", "game is not active");
    if (stored.value.game.whiteUserId !== userId && stored.value.game.blackUserId !== userId) throw new PlatformError("FORBIDDEN", "user is not a player");
    return stored.value;
  }

  async respondToDraw(gameId: GameId, userId: UserId, _accept: boolean, expectedRevision: number): Promise<VersionedGame> {
    return this.offerDraw(gameId, userId, expectedRevision);
  }

  async cancelChallenge(gameId: GameId, userId: UserId): Promise<void> {
    const stored = this.#require(gameId);
    if (stored.value.game.status !== "created") throw new PlatformError("INVALID_STATE", "challenge is no longer pending");
    if (stored.value.game.whiteUserId !== userId && stored.value.game.blackUserId !== userId) throw new PlatformError("FORBIDDEN", "user is not a player");
    stored.value = { ...stored.value, game: { ...stored.value.game, status: "aborted" } };
  }

  async requestRematch(gameId: GameId, userId: UserId): Promise<void> {
    const game = this.#require(gameId).value.game;
    if (game.status === "started" || game.status === "created") throw new PlatformError("INVALID_STATE", "game is not complete");
    if (game.whiteUserId !== userId && game.blackUserId !== userId) throw new PlatformError("FORBIDDEN", "user is not a player");
  }

  async exportPgn(gameId: GameId): Promise<Pgn> {
    return this.#require(gameId).pgn;
  }

  #require(gameId: GameId): StoredGame {
    const stored = this.#games.get(gameId);
    if (stored === undefined) throw new PlatformError("NOT_FOUND", `game ${gameId} was not found`);
    return stored;
  }

  #assertRevision(stored: StoredGame, expected: number): void {
    if (stored.value.revision !== expected) throw new PlatformError("CONFLICT", "game changed; reload before retrying", true);
  }
}

export function fenOf(game: VersionedGame): Fen {
  return game.game.currentFen;
}

export * from "./lichess.js";
