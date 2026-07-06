import { randomUUID } from "node:crypto";
import {
  ChessRules,
  validatePgn,
  type ChessGame,
  type Fen,
  type UciMove
} from "@chess-agent/chess-domain";
import type { ChessPlatform } from "@chess-agent/platform-adapter";
import type { EngineAnalysis, EngineScore, EngineService } from "@chess-agent/engine";
import type { GameId, Job, JobId, ReviewId, UserId } from "@chess-agent/shared-types";

export type MoveClassification = "inaccuracy" | "mistake" | "blunder";
export type ReviewTheme = "tactics" | "king-safety" | "piece-activity" | "pawn-play" | "conversion";

export interface CriticalMoment {
  readonly ply: number;
  readonly fenBefore: Fen;
  readonly playedMove: UciMove;
  readonly bestMove?: UciMove;
  readonly lossCentipawns: number;
  readonly classification: MoveClassification;
  readonly themes: readonly ReviewTheme[];
  readonly bestLine: readonly UciMove[];
  readonly depth: number;
}

export interface ReviewArtifact {
  readonly id: ReviewId;
  readonly gameId: GameId;
  readonly requestedBy: UserId;
  readonly generatedAt: string;
  readonly engineDepth: number;
  readonly criticalMoments: readonly CriticalMoment[];
  readonly analyzedPositions: number;
}

export interface ReviewServiceOptions {
  readonly depth?: number;
  readonly maxCriticalMoments?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => Date;
}

export interface ReviewArtifactRepository {
  getReview(id: string): Promise<ReviewArtifact | undefined>;
  saveReview(value: ReviewArtifact): Promise<void>;
  getReviewJob?(id: string): Promise<{ readonly owner: UserId; readonly job: Job<ReviewArtifact> } | undefined>;
  saveReviewJob?(id: string, owner: UserId, job: Job<ReviewArtifact>): Promise<void>;
}

export class GameReviewService {
  readonly #jobs = new Map<JobId, Job<ReviewArtifact>>();
  readonly #reviews = new Map<ReviewId, ReviewArtifact>();
  readonly #owners = new Map<JobId, UserId>();
  readonly #depth: number;
  readonly #maxMoments: number;
  readonly #pollIntervalMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => Date;

  constructor(
    private readonly platform: ChessPlatform,
    private readonly engine: EngineService,
    options: ReviewServiceOptions = {},
    private readonly repository?: ReviewArtifactRepository
  ) {
    this.#depth = bounded(options.depth ?? 18, 1, 30, "depth");
    this.#maxMoments = bounded(options.maxCriticalMoments ?? 5, 1, 10, "maxCriticalMoments");
    this.#pollIntervalMs = bounded(options.pollIntervalMs ?? 100, 0, 60_000, "pollIntervalMs");
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#now = options.now ?? (() => new Date());
  }

  async startReview(gameId: GameId, requestedBy: UserId): Promise<{ readonly jobId: JobId }> {
    const jobId = randomUUID() as JobId;
    await this.#setJob(jobId, requestedBy, { id: jobId, status: "queued", progress: 0 });
    this.#owners.set(jobId, requestedBy);
    void this.#run(jobId, gameId, requestedBy);
    return { jobId };
  }

  async getJob(jobId: JobId, requestedBy?: UserId): Promise<Job<ReviewArtifact>> {
    const persisted = this.#jobs.has(jobId) ? undefined : await this.repository?.getReviewJob?.(jobId);
    if (persisted !== undefined) {
      this.#jobs.set(jobId, persisted.job);
      this.#owners.set(jobId, persisted.owner);
    }
    const job = this.#jobs.get(jobId);
    if (job === undefined) throw new ReviewServiceError("NOT_FOUND", "Review job was not found");
    if (requestedBy !== undefined && this.#owners.get(jobId) !== requestedBy) throw new ReviewServiceError("FORBIDDEN", "User cannot access this review job");
    return job;
  }

  async getReview(reviewId: ReviewId): Promise<ReviewArtifact> {
    const review = this.#reviews.get(reviewId) ?? await this.repository?.getReview(reviewId);
    if (review === undefined) throw new ReviewServiceError("NOT_FOUND", "Review was not found");
    return review;
  }

  async #run(jobId: JobId, gameId: GameId, requestedBy: UserId): Promise<void> {
    await this.#setJob(jobId, requestedBy, { id: jobId, status: "running", progress: 5 });
    try {
      const { game } = await this.platform.getGame(gameId);
      assertReviewable(game, requestedBy);
      validatePgn(await this.platform.exportPgn(gameId));
      const positions = positionsFor(game);
      const analyses: EngineAnalysis[] = [];
      for (let index = 0; index < positions.length; index += 1) {
        const { jobId: engineJobId } = await this.engine.submit({ fen: positions[index] as Fen, depth: this.#depth, multiPv: 2 });
        analyses.push(await this.#waitForAnalysis(engineJobId));
        await this.#setJob(jobId, requestedBy, {
          id: jobId,
          status: "running",
          progress: Math.min(95, 5 + Math.round(((index + 1) / positions.length) * 85))
        });
      }
      const reviewId = randomUUID() as ReviewId;
      const artifact: ReviewArtifact = {
        id: reviewId,
        gameId,
        requestedBy,
        generatedAt: this.#now().toISOString(),
        engineDepth: this.#depth,
        criticalMoments: selectCriticalMoments(game, positions, analyses, this.#maxMoments),
        analyzedPositions: analyses.length
      };
      this.#reviews.set(reviewId, artifact);
      await this.repository?.saveReview(artifact);
      await this.#setJob(jobId, requestedBy, { id: jobId, status: "succeeded", progress: 100, result: artifact });
    } catch (error) {
      const message = error instanceof ReviewServiceError ? error.message : "Game review failed";
      await this.#setJob(jobId, requestedBy, {
        id: jobId,
        status: "failed",
        progress: 100,
        error: { code: "BAD_REQUEST", message, retryable: false }
      });
    }
  }

  async #setJob(jobId: JobId, owner: UserId, job: Job<ReviewArtifact>): Promise<void> {
    this.#jobs.set(jobId, job);
    this.#owners.set(jobId, owner);
    await this.repository?.saveReviewJob?.(jobId, owner, job);
  }

  async #waitForAnalysis(jobId: JobId): Promise<EngineAnalysis> {
    for (;;) {
      const job = await this.engine.getJob(jobId);
      if (job.status === "succeeded" && job.result !== undefined) return job.result;
      if (job.status === "failed" || job.status === "cancelled") throw new ReviewServiceError("ENGINE_FAILED", "Position analysis failed");
      await this.#sleep(this.#pollIntervalMs);
    }
  }
}

export type ReviewServiceErrorCode = "NOT_FOUND" | "NOT_COMPLETED" | "FORBIDDEN" | "ENGINE_FAILED" | "UNSUPPORTED_VARIANT";

export class ReviewServiceError extends Error {
  constructor(readonly code: ReviewServiceErrorCode, message: string) {
    super(message);
    this.name = "ReviewServiceError";
  }
}

function assertReviewable(game: ChessGame, userId: UserId): void {
  if (game.status === "started" || game.status === "created") throw new ReviewServiceError("NOT_COMPLETED", "Only completed games can be reviewed");
  if (game.whiteUserId !== userId && game.blackUserId !== userId) throw new ReviewServiceError("FORBIDDEN", "User cannot review this game");
  if (game.variant !== "standard") throw new ReviewServiceError("UNSUPPORTED_VARIANT", `Reviews do not yet support ${game.variant} games`);
}

function positionsFor(game: ChessGame): Fen[] {
  const rules = new ChessRules();
  const positions: Fen[] = [rules.state().fen];
  for (const move of game.moves) {
    rules.makeMove(move.uci);
    positions.push(rules.state().fen);
  }
  return positions;
}

function selectCriticalMoments(
  game: ChessGame,
  positions: readonly Fen[],
  analyses: readonly EngineAnalysis[],
  limit: number
): CriticalMoment[] {
  const candidates: CriticalMoment[] = [];
  for (let index = 0; index < game.moves.length; index += 1) {
    const before = analyses[index];
    const after = analyses[index + 1];
    const move = game.moves[index];
    if (before === undefined || after === undefined || move === undefined) continue;
    const bestForMover = scoreValue(before.variations[0]?.score);
    const resultForMover = -scoreValue(after.variations[0]?.score);
    const loss = Math.max(0, Math.min(100_000, bestForMover - resultForMover));
    if (loss < 50) continue;
    candidates.push({
      ply: index + 1,
      fenBefore: positions[index] as Fen,
      playedMove: move.uci,
      ...(before.bestMove === undefined ? {} : { bestMove: before.bestMove }),
      lossCentipawns: loss,
      classification: loss >= 200 ? "blunder" : loss >= 100 ? "mistake" : "inaccuracy",
      themes: classifyThemes(move.san, loss, before),
      bestLine: before.variations[0]?.moves ?? [],
      depth: before.depth
    });
  }
  return candidates
    .sort((a, b) => b.lossCentipawns - a.lossCentipawns || a.ply - b.ply)
    .slice(0, limit)
    .sort((a, b) => a.ply - b.ply);
}

function scoreValue(score: EngineScore | undefined): number {
  if (score === undefined) return 0;
  if (score.type === "centipawn") return score.value;
  return Math.sign(score.value) * (100_000 - Math.min(Math.abs(score.value), 1_000));
}

function classifyThemes(san: string, loss: number, analysis: EngineAnalysis): ReviewTheme[] {
  const themes = new Set<ReviewTheme>();
  if (loss >= 200 || analysis.variations.some(({ score }) => score.type === "mate")) themes.add("tactics");
  if (san.includes("+") || san.includes("#") || san === "O-O" || san === "O-O-O") themes.add("king-safety");
  if (/^[a-h]/.test(san)) themes.add("pawn-play");
  if (loss >= 100 && themes.size === 0) themes.add("piece-activity");
  if (themes.size === 0) themes.add("conversion");
  return [...themes];
}

function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be from ${min} to ${max}`);
  return value;
}
