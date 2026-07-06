import type { ChessGame, Color, GameMode } from "@chess-agent/chess-domain";
import type { ChessPlatform, PlatformError } from "@chess-agent/platform-adapter";
import {
  normalizePageRequest,
  parseId,
  type ApiError,
  type GameId,
  type JobId,
  type PuzzleId,
  type SessionId,
  type UserId
} from "@chess-agent/shared-types";

export type ToolName =
  | "create_game"
  | "get_game"
  | "make_move"
  | "resign_game"
  | "offer_draw"
  | "respond_draw"
  | "cancel_challenge"
  | "request_rematch"
  | "list_recent_games"
  | "review_game"
  | "get_review"
  | "create_puzzle"
  | "submit_puzzle_move"
  | "get_puzzle_hint";

export interface AgentSession {
  readonly id: SessionId;
  readonly activeGameId?: GameId;
  readonly activePuzzleId?: PuzzleId;
  readonly mode: "idle" | "playing" | "reviewing" | "puzzle";
}

export interface ReviewGateway {
  startReview(gameId: GameId, requestedBy: UserId): Promise<{ readonly jobId: JobId }>;
  getJob(jobId: JobId, requestedBy?: UserId): Promise<unknown>;
}

export interface PuzzleGateway {
  createPuzzle(options: {
    readonly requestedBy: UserId;
    readonly rating?: number;
    readonly theme?: string;
  }): Promise<{ readonly puzzleId: PuzzleId }>;
  getPuzzle(puzzleId: PuzzleId): Promise<unknown>;
  submitMove(userId: UserId, puzzleId: PuzzleId, notation: string): Promise<unknown>;
  getHint(userId: UserId, puzzleId: PuzzleId, level: 1 | 2 | 3): string;
}

export interface AuditRecord {
  readonly occurredAt: string;
  readonly requestId: string;
  readonly callId: string;
  readonly userId: UserId;
  readonly tool: ToolName;
  readonly success: boolean;
  readonly errorCode?: string;
}

export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
}

export interface ToolContext {
  readonly requestId: string;
  readonly userId: UserId;
  readonly session: AgentSession;
  readonly platform: ChessPlatform;
  readonly reviews: ReviewGateway;
  readonly puzzles: PuzzleGateway;
  readonly audit: AuditSink;
  readonly now?: () => Date;
}

export interface ToolCall {
  readonly id: string;
  readonly name: ToolName;
  readonly arguments: unknown;
}

export type ToolResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: ApiError };

export interface ToolDescriptor {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  descriptor("create_game", "Create a human or computer chess game.", {
    mode: { type: "string", enum: ["human", "computer"] },
    color: { type: "string", enum: ["white", "black"] },
    computerLevel: { type: "integer", minimum: 1, maximum: 8 },
    opponentUsername: { type: "string", minLength: 1, maxLength: 64 },
    rated: { type: "boolean" },
    daysPerTurn: { type: "integer", minimum: 1, maximum: 14 },
    initialMs: { type: "integer", minimum: 1_000, maximum: 86_400_000 },
    incrementMs: { type: "integer", minimum: 0, maximum: 60_000 }
  }, ["mode", "color"]),
  descriptor("get_game", "Get authoritative state for one accessible game.", {
    gameId: { type: "string", minLength: 1, maxLength: 128 }
  }, ["gameId"]),
  descriptor("make_move", "Submit the user's chosen move to the active game.", {
    gameId: { type: "string", minLength: 1, maxLength: 128 },
    move: { type: "string", minLength: 1, maxLength: 16 },
    expectedRevision: { type: "integer", minimum: 0 }
  }, ["gameId", "move", "expectedRevision"]),
  descriptor("resign_game", "Resign an active game after the user explicitly requests or confirms resignation.", {
    gameId: { type: "string", minLength: 1, maxLength: 128 },
    expectedRevision: { type: "integer", minimum: 0 }
  }, ["gameId", "expectedRevision"]),
  descriptor("offer_draw", "Offer a draw in an active game.", {
    gameId: { type: "string", minLength: 1, maxLength: 128 },
    expectedRevision: { type: "integer", minimum: 0 }
  }, ["gameId", "expectedRevision"]),
  descriptor("respond_draw", "Accept or decline an opponent's draw offer.", {
    gameId: { type: "string", minLength: 1, maxLength: 128 },
    accept: { type: "boolean" },
    expectedRevision: { type: "integer", minimum: 0 }
  }, ["gameId", "accept", "expectedRevision"]),
  descriptor("cancel_challenge", "Cancel a pending outgoing challenge.", {
    gameId: { type: "string", minLength: 1, maxLength: 128 }
  }, ["gameId"]),
  descriptor("request_rematch", "Request a rematch after a completed game.", {
    gameId: { type: "string", minLength: 1, maxLength: 128 }
  }, ["gameId"]),
  descriptor("list_recent_games", "List the current user's recent games.", {
    cursor: { type: "string", minLength: 1, maxLength: 256 },
    limit: { type: "integer", minimum: 1, maximum: 100 }
  }, []),
  descriptor("review_game", "Start analysis of a completed game.", {
    gameId: { type: "string", minLength: 1, maxLength: 128 }
  }, ["gameId"]),
  descriptor("get_review", "Read the current status or completed artifact for a review job.", {
    jobId: { type: "string", minLength: 1, maxLength: 128 }
  }, ["jobId"]),
  descriptor("create_puzzle", "Create a training puzzle for the current user.", {
    rating: { type: "integer", minimum: 400, maximum: 3_500 },
    theme: { type: "string", minLength: 1, maxLength: 64 }
  }, []),
  descriptor("submit_puzzle_move", "Submit one move to the active puzzle.", {
    puzzleId: { type: "string", minLength: 1, maxLength: 128 },
    move: { type: "string", minLength: 4, maxLength: 5 }
  }, ["puzzleId", "move"]),
  descriptor("get_puzzle_hint", "Request a controlled hint for the active puzzle.", {
    puzzleId: { type: "string", minLength: 1, maxLength: 128 },
    level: { type: "integer", minimum: 1, maximum: 3 }
  }, ["puzzleId", "level"])
];

export class AgentToolExecutor {
  constructor(private readonly context: ToolContext) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    let result: ToolResult;
    try {
      const value = await this.#dispatch(call);
      result = { ok: true, value };
    } catch (error) {
      result = { ok: false, error: normalizeError(error) };
    }
    await this.context.audit.write({
      occurredAt: (this.context.now ?? (() => new Date()))().toISOString(),
      requestId: this.context.requestId,
      callId: call.id,
      userId: this.context.userId,
      tool: call.name,
      success: result.ok,
      ...(result.ok ? {} : { errorCode: result.error.code })
    });
    return result;
  }

  async #dispatch(call: ToolCall): Promise<unknown> {
    const args = requireRecord(call.arguments);
    switch (call.name) {
      case "create_game": {
        const mode = requireEnum(args.mode, ["human", "computer"] as const, "mode");
        const color = requireEnum(args.color, ["white", "black"] as const, "color");
        const initialMs = optionalInteger(args.initialMs, "initialMs", 1_000, 86_400_000);
        const incrementMs = optionalInteger(args.incrementMs, "incrementMs", 0, 60_000);
        const computerLevel = optionalInteger(args.computerLevel, "computerLevel", 1, 8);
        const daysPerTurn = optionalInteger(args.daysPerTurn, "daysPerTurn", 1, 14);
        const opponentUsername = args.opponentUsername === undefined
          ? undefined
          : requireString(args.opponentUsername, "opponentUsername", 1, 64);
        if (mode === "human" && opponentUsername === undefined) {
          throw new ToolInputError("opponentUsername is required for a human game");
        }
        if (args.rated !== undefined && typeof args.rated !== "boolean") {
          throw new ToolInputError("rated must be a boolean");
        }
        return this.context.platform.createGame(
          {
            requesterUserId: this.context.userId,
            mode: mode as GameMode,
            color: color as Color,
            ...(initialMs === undefined ? {} : { initialMs }),
            ...(incrementMs === undefined ? {} : { incrementMs }),
            ...(computerLevel === undefined ? {} : { computerLevel }),
            ...(opponentUsername === undefined ? {} : { opponentUsername }),
            ...(args.rated === undefined ? {} : { rated: args.rated }),
            ...(daysPerTurn === undefined ? {} : { daysPerTurn })
          },
          `${this.context.requestId}:${call.id}`
        );
      }
      case "get_game": {
        const game = await this.context.platform.getGame(gameId(args.gameId));
        assertCanAccess(game.game, this.context.userId);
        return game;
      }
      case "make_move": {
        const id = gameId(args.gameId);
        const current = await this.context.platform.getGame(id);
        assertCanMove(current.game, this.context.userId);
        return this.context.platform.makeMove(
          id,
          requireString(args.move, "move", 1, 16),
          requireInteger(args.expectedRevision, "expectedRevision", 0, Number.MAX_SAFE_INTEGER)
        );
      }
      case "resign_game": {
        const id = gameId(args.gameId);
        const current = await this.context.platform.getGame(id);
        assertCanMove(current.game, this.context.userId);
        return this.context.platform.resign(
          id,
          this.context.userId,
          requireInteger(args.expectedRevision, "expectedRevision", 0, Number.MAX_SAFE_INTEGER)
        );
      }
      case "offer_draw": {
        const id = gameId(args.gameId);
        const current = await this.context.platform.getGame(id);
        assertCanMove(current.game, this.context.userId);
        return this.context.platform.offerDraw(
          id,
          this.context.userId,
          requireInteger(args.expectedRevision, "expectedRevision", 0, Number.MAX_SAFE_INTEGER)
        );
      }
      case "respond_draw": {
        const id = gameId(args.gameId);
        const current = await this.context.platform.getGame(id);
        assertCanMove(current.game, this.context.userId);
        if (typeof args.accept !== "boolean") throw new ToolInputError("accept must be a boolean");
        return this.context.platform.respondToDraw(
          id,
          this.context.userId,
          args.accept,
          requireInteger(args.expectedRevision, "expectedRevision", 0, Number.MAX_SAFE_INTEGER)
        );
      }
      case "cancel_challenge": {
        const id = gameId(args.gameId);
        await this.context.platform.cancelChallenge(id, this.context.userId);
        return { gameId: id, cancelled: true };
      }
      case "request_rematch": {
        const id = gameId(args.gameId);
        await this.context.platform.requestRematch(id, this.context.userId);
        return { gameId: id, requested: true };
      }
      case "list_recent_games": {
        return this.context.platform.listRecentGames(
          this.context.userId,
          normalizePageRequest({
            ...(args.cursor === undefined ? {} : { cursor: requireString(args.cursor, "cursor", 1, 256) }),
            ...(args.limit === undefined ? {} : { limit: requireInteger(args.limit, "limit", 1, 100) })
          })
        );
      }
      case "review_game": {
        await this.#assertAnalysisAllowed();
        const id = gameId(args.gameId);
        const game = await this.context.platform.getGame(id);
        assertCanAccess(game.game, this.context.userId);
        if (game.game.status === "started") throw policyError("Only completed games can be reviewed");
        return this.context.reviews.startReview(id, this.context.userId);
      }
      case "get_review": {
        await this.#assertAnalysisAllowed();
        return this.context.reviews.getJob(jobId(args.jobId), this.context.userId);
      }
      case "create_puzzle": {
        await this.#assertAnalysisAllowed();
        const rating = optionalInteger(args.rating, "rating", 400, 3_500);
        const theme = args.theme === undefined ? undefined : requireString(args.theme, "theme", 1, 64);
        const created = await this.context.puzzles.createPuzzle({
          requestedBy: this.context.userId,
          ...(rating === undefined ? {} : { rating }),
          ...(theme === undefined ? {} : { theme })
        });
        return { ...created, puzzle: await this.context.puzzles.getPuzzle(created.puzzleId) };
      }
      case "submit_puzzle_move": {
        await this.#assertAnalysisAllowed();
        const id = puzzleId(args.puzzleId);
        assertActivePuzzle(this.context.session, id);
        return this.context.puzzles.submitMove(
          this.context.userId,
          id,
          requireString(args.move, "move", 4, 5)
        );
      }
      case "get_puzzle_hint": {
        await this.#assertAnalysisAllowed();
        const id = puzzleId(args.puzzleId);
        assertActivePuzzle(this.context.session, id);
        const level = requireInteger(args.level, "level", 1, 3) as 1 | 2 | 3;
        return { hint: this.context.puzzles.getHint(this.context.userId, id, level) };
      }
    }
  }

  async #assertAnalysisAllowed(): Promise<void> {
    if (this.context.session.activeGameId === undefined) return;
    const { game } = await this.context.platform.getGame(this.context.session.activeGameId);
    if (game.mode === "human" && game.status === "started") {
      throw policyError("Analysis, puzzles, and coaching are disabled during an active human game");
    }
  }
}

export class MemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];
  async write(record: AuditRecord): Promise<void> {
    this.records.push(record);
  }
}

function assertCanAccess(game: ChessGame, userId: UserId): void {
  if (game.whiteUserId !== userId && game.blackUserId !== userId) throw policyError("User cannot access this game");
}

function assertCanMove(game: ChessGame, userId: UserId): void {
  assertCanAccess(game, userId);
  if (game.status !== "started") throw policyError("Game is not active");
  const activeColor = game.currentFen.split(" ")[1] === "w" ? "white" : "black";
  const userColor = game.whiteUserId === userId ? "white" : "black";
  if (activeColor !== userColor) throw policyError("It is not the user's turn");
}

function normalizeError(error: unknown): ApiError {
  if (isPlatformError(error)) {
    const code = error.code === "NOT_FOUND" ? "NOT_FOUND"
      : error.code === "CONFLICT" ? "CONFLICT"
      : error.code === "FORBIDDEN" ? "FORBIDDEN"
      : "BAD_REQUEST";
    return { code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof ToolInputError) return { code: "BAD_REQUEST", message: error.message, retryable: false };
  if (error instanceof ToolPolicyError) return { code: "FORBIDDEN", message: error.message, retryable: false };
  return { code: "INTERNAL", message: "Tool execution failed", retryable: true };
}

function isPlatformError(error: unknown): error is PlatformError {
  return error instanceof Error && "code" in error && "retryable" in error;
}

class ToolInputError extends Error {}
class ToolPolicyError extends Error {}

function policyError(message: string): ToolPolicyError {
  return new ToolPolicyError(message);
}

function gameId(value: unknown): GameId {
  return parseId<"GameId">(value, "gameId") as GameId;
}

function jobId(value: unknown): JobId {
  return parseId<"JobId">(value, "jobId") as JobId;
}

function puzzleId(value: unknown): PuzzleId {
  return parseId<"PuzzleId">(value, "puzzleId") as PuzzleId;
}

function assertActivePuzzle(session: AgentSession, puzzleId: PuzzleId): void {
  if (session.activePuzzleId !== puzzleId) throw policyError("Puzzle is not active in this session");
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ToolInputError("arguments must be an object");
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) throw new ToolInputError(`${name} has an invalid length`);
  return value;
}

function requireInteger(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new ToolInputError(`${name} must be an integer from ${min} to ${max}`);
  return Number(value);
}

function optionalInteger(value: unknown, name: string, min: number, max: number): number | undefined {
  return value === undefined ? undefined : requireInteger(value, name, min, max);
}

function requireEnum<const T extends readonly string[]>(value: unknown, choices: T, name: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new ToolInputError(`${name} must be one of: ${choices.join(", ")}`);
  return value as T[number];
}

function descriptor(
  name: ToolName,
  description: string,
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[]
): ToolDescriptor {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      required
    }
  };
}
