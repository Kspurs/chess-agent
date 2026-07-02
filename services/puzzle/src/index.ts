import { ChessRules, parseFen, parseUciMove, type Fen, type UciMove } from "@chess-agent/chess-domain";
import type { PuzzleId, UserId } from "@chess-agent/shared-types";

export interface PuzzleRecord {
  readonly id: PuzzleId;
  readonly initialFen: Fen;
  readonly solution: readonly UciMove[];
  readonly rating: number;
  readonly themes: readonly string[];
  readonly source: string;
  readonly license: string;
}

export interface PublicPuzzle {
  readonly id: PuzzleId;
  readonly initialFen: Fen;
  readonly rating: number;
  readonly themes: readonly string[];
}

export interface PuzzleAttempt {
  readonly puzzleId: PuzzleId;
  readonly userId: UserId;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly solved: boolean;
  readonly hintsUsed: number;
  readonly ratingBefore: number;
  readonly ratingAfter: number;
}

export interface PuzzleSubmission {
  readonly correct: boolean;
  readonly complete: boolean;
  readonly fen: Fen;
  readonly opponentMove?: UciMove;
  readonly message: string;
}

export interface PuzzleRepository {
  list(): Promise<readonly PuzzleRecord[]>;
  get(id: PuzzleId): Promise<PuzzleRecord | undefined>;
}

export class InMemoryPuzzleRepository implements PuzzleRepository {
  readonly #puzzles = new Map<PuzzleId, PuzzleRecord>();

  import(records: readonly PuzzleRecord[]): void {
    for (const record of records) {
      validatePuzzle(record);
      this.#puzzles.set(record.id, record);
    }
  }

  async list(): Promise<readonly PuzzleRecord[]> {
    return [...this.#puzzles.values()];
  }

  async get(id: PuzzleId): Promise<PuzzleRecord | undefined> {
    return this.#puzzles.get(id);
  }
}

interface ActivePuzzle {
  readonly puzzle: PuzzleRecord;
  readonly startedAt: string;
  readonly ratingBefore: number;
  nextIndex: number;
  hintsUsed: number;
  completed: boolean;
}

export class PuzzleService {
  readonly #active = new Map<string, ActivePuzzle>();
  readonly #recent = new Map<UserId, PuzzleId[]>();
  readonly #ratings = new Map<UserId, number>();
  readonly #attempts: PuzzleAttempt[] = [];

  constructor(
    private readonly repository: PuzzleRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  async createPuzzle(options: {
    readonly requestedBy: UserId;
    readonly rating?: number;
    readonly theme?: string;
  }): Promise<{ readonly puzzleId: PuzzleId }> {
    const target = options.rating ?? this.ratingFor(options.requestedBy);
    if (!Number.isInteger(target) || target < 400 || target > 3_500) throw new PuzzleServiceError("INVALID_REQUEST", "Puzzle rating must be from 400 to 3500");
    const recent = new Set(this.#recent.get(options.requestedBy) ?? []);
    const all = (await this.repository.list()).filter((puzzle) =>
      options.theme === undefined || puzzle.themes.includes(options.theme as string)
    );
    const candidates = all.filter(({ id }) => !recent.has(id));
    const pool = candidates.length > 0 ? candidates : all;
    const puzzle = [...pool].sort((a, b) =>
      Math.abs(a.rating - target) - Math.abs(b.rating - target) || String(a.id).localeCompare(String(b.id))
    )[0];
    if (puzzle === undefined) throw new PuzzleServiceError("NOT_FOUND", "No puzzle matches the requested filters");

    const key = sessionKey(options.requestedBy, puzzle.id);
    this.#active.set(key, {
      puzzle,
      startedAt: this.now().toISOString(),
      ratingBefore: this.ratingFor(options.requestedBy),
      nextIndex: 0,
      hintsUsed: 0,
      completed: false
    });
    const history = [...(this.#recent.get(options.requestedBy) ?? []), puzzle.id].slice(-50);
    this.#recent.set(options.requestedBy, history);
    return { puzzleId: puzzle.id };
  }

  async getPuzzle(puzzleId: PuzzleId): Promise<PublicPuzzle> {
    const puzzle = await this.#requirePuzzle(puzzleId);
    return {
      id: puzzle.id,
      initialFen: puzzle.initialFen,
      rating: puzzle.rating,
      themes: puzzle.themes
    };
  }

  async submitMove(userId: UserId, puzzleId: PuzzleId, notation: string): Promise<PuzzleSubmission> {
    const active = this.#requireActive(userId, puzzleId);
    if (active.completed) throw new PuzzleServiceError("COMPLETED", "Puzzle session is already complete");
    const move = parseUciMove(notation);
    const rules = positionAt(active.puzzle, active.nextIndex);
    try {
      rules.makeMove(move);
    } catch {
      return this.#finishIncorrect(userId, active, rules.state().fen, "That move is illegal in this position.");
    }
    const expected = active.puzzle.solution[active.nextIndex];
    if (move !== expected) return this.#finishIncorrect(userId, active, rules.state().fen, "That move is legal, but it misses the puzzle idea.");

    active.nextIndex += 1;
    let opponentMove: UciMove | undefined;
    if (active.nextIndex < active.puzzle.solution.length) {
      opponentMove = active.puzzle.solution[active.nextIndex] as UciMove;
      rules.makeMove(opponentMove);
      active.nextIndex += 1;
    }
    const complete = active.nextIndex >= active.puzzle.solution.length;
    if (complete) this.#finish(userId, active, true);
    return {
      correct: true,
      complete,
      fen: rules.state().fen,
      ...(opponentMove === undefined ? {} : { opponentMove }),
      message: complete ? "Puzzle solved." : "Correct. Find the continuation."
    };
  }

  getHint(userId: UserId, puzzleId: PuzzleId, level: 1 | 2 | 3): string {
    const active = this.#requireActive(userId, puzzleId);
    if (active.completed) throw new PuzzleServiceError("COMPLETED", "Puzzle session is already complete");
    active.hintsUsed = Math.max(active.hintsUsed, level);
    const expected = active.puzzle.solution[active.nextIndex] as UciMove;
    if (level === 1) return `Theme: ${active.puzzle.themes.join(", ") || "calculation"}.`;
    if (level === 2) return `Look for a move to ${expected.slice(2, 4)}.`;
    return `Candidate move: ${expected}.`;
  }

  ratingFor(userId: UserId): number {
    return this.#ratings.get(userId) ?? 1_200;
  }

  attemptsFor(userId: UserId): readonly PuzzleAttempt[] {
    return this.#attempts.filter((attempt) => attempt.userId === userId);
  }

  #finishIncorrect(userId: UserId, active: ActivePuzzle, fen: Fen, message: string): PuzzleSubmission {
    this.#finish(userId, active, false);
    return { correct: false, complete: true, fen, message };
  }

  #finish(userId: UserId, active: ActivePuzzle, solved: boolean): void {
    active.completed = true;
    const expected = 1 / (1 + 10 ** ((active.puzzle.rating - active.ratingBefore) / 400));
    const penalty = Math.min(active.hintsUsed * 0.1, 0.3);
    const score = solved ? 1 - penalty : 0;
    const ratingAfter = Math.max(400, Math.min(3_500, Math.round(active.ratingBefore + 24 * (score - expected))));
    this.#ratings.set(userId, ratingAfter);
    this.#attempts.push({
      puzzleId: active.puzzle.id,
      userId,
      startedAt: active.startedAt,
      completedAt: this.now().toISOString(),
      solved,
      hintsUsed: active.hintsUsed,
      ratingBefore: active.ratingBefore,
      ratingAfter
    });
  }

  async #requirePuzzle(id: PuzzleId): Promise<PuzzleRecord> {
    const puzzle = await this.repository.get(id);
    if (puzzle === undefined) throw new PuzzleServiceError("NOT_FOUND", "Puzzle was not found");
    return puzzle;
  }

  #requireActive(userId: UserId, puzzleId: PuzzleId): ActivePuzzle {
    const active = this.#active.get(sessionKey(userId, puzzleId));
    if (active === undefined) throw new PuzzleServiceError("NOT_FOUND", "Active puzzle session was not found");
    return active;
  }
}

export type PuzzleServiceErrorCode = "INVALID_REQUEST" | "NOT_FOUND" | "COMPLETED";

export class PuzzleServiceError extends Error {
  constructor(readonly code: PuzzleServiceErrorCode, message: string) {
    super(message);
    this.name = "PuzzleServiceError";
  }
}

function validatePuzzle(record: PuzzleRecord): void {
  parseFen(record.initialFen);
  if (!record.source.trim() || !record.license.trim()) throw new TypeError("Puzzle source and license are required");
  if (!Number.isInteger(record.rating) || record.rating < 400 || record.rating > 3_500) throw new TypeError("Invalid puzzle rating");
  if (record.solution.length === 0) throw new TypeError("Puzzle solution cannot be empty");
  const rules = new ChessRules(record.initialFen);
  for (const move of record.solution) rules.makeMove(parseUciMove(move));
}

function positionAt(puzzle: PuzzleRecord, moveCount: number): ChessRules {
  const rules = new ChessRules(puzzle.initialFen);
  for (const move of puzzle.solution.slice(0, moveCount)) rules.makeMove(move);
  return rules;
}

function sessionKey(userId: UserId, puzzleId: PuzzleId): string {
  return `${userId}:${puzzleId}`;
}

