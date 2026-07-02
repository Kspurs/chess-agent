import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseFen, type Color, type Fen, type UciMove } from "@chess-agent/chess-domain";
import type { Job, JobId } from "@chess-agent/shared-types";

export interface AnalysisRequest {
  readonly fen: Fen;
  readonly depth: number;
  readonly multiPv: number;
}

export type EngineScore =
  | { readonly type: "centipawn"; readonly value: number }
  | { readonly type: "mate"; readonly value: number };

export interface PrincipalVariation {
  readonly rank: number;
  readonly depth: number;
  readonly score: EngineScore;
  readonly moves: readonly UciMove[];
}

export interface EngineAnalysis {
  readonly fen: Fen;
  readonly perspective: Color;
  readonly depth: number;
  readonly variations: readonly PrincipalVariation[];
  readonly bestMove?: UciMove;
}

export interface AnalysisWorker {
  analyze(request: AnalysisRequest): Promise<EngineAnalysis>;
  dispose?(): Promise<void>;
}

export interface EngineService {
  submit(request: AnalysisRequest): Promise<{ readonly jobId: JobId }>;
  getJob(jobId: JobId): Promise<Job<EngineAnalysis>>;
}

export class StockfishAnalysisService implements EngineService {
  readonly #jobs = new Map<JobId, Job<EngineAnalysis>>();
  readonly #cache = new Map<string, EngineAnalysis>();
  readonly #available: AnalysisWorker[];
  readonly #waiting: Array<(worker: AnalysisWorker) => void> = [];

  constructor(workers: readonly AnalysisWorker[]) {
    if (workers.length === 0) throw new RangeError("At least one analysis worker is required");
    this.#available = [...workers];
  }

  async submit(input: AnalysisRequest): Promise<{ readonly jobId: JobId }> {
    const request = validateRequest(input);
    const jobId = randomUUID() as JobId;
    this.#jobs.set(jobId, { id: jobId, status: "queued", progress: 0 });
    void this.#run(jobId, request);
    return { jobId };
  }

  async getJob(jobId: JobId): Promise<Job<EngineAnalysis>> {
    const job = this.#jobs.get(jobId);
    if (job === undefined) throw new EngineServiceError("NOT_FOUND", "Analysis job was not found");
    return job;
  }

  async #run(jobId: JobId, request: AnalysisRequest): Promise<void> {
    const key = cacheKey(request);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#jobs.set(jobId, { id: jobId, status: "succeeded", progress: 100, result: cached });
      return;
    }
    const worker = await this.#acquire();
    this.#jobs.set(jobId, { id: jobId, status: "running", progress: 10 });
    try {
      const result = await worker.analyze(request);
      this.#cache.set(key, result);
      this.#jobs.set(jobId, { id: jobId, status: "succeeded", progress: 100, result });
    } catch {
      this.#jobs.set(jobId, {
        id: jobId,
        status: "failed",
        progress: 100,
        error: { code: "INTERNAL", message: "Stockfish analysis failed", retryable: true }
      });
    } finally {
      this.#release(worker);
    }
  }

  #acquire(): Promise<AnalysisWorker> {
    const worker = this.#available.pop();
    if (worker !== undefined) return Promise.resolve(worker);
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  #release(worker: AnalysisWorker): void {
    const waiter = this.#waiting.shift();
    if (waiter === undefined) this.#available.push(worker);
    else waiter(worker);
  }
}

export type EngineServiceErrorCode = "NOT_FOUND" | "INVALID_REQUEST" | "PROCESS_FAILURE" | "TIMEOUT";

export class EngineServiceError extends Error {
  constructor(readonly code: EngineServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EngineServiceError";
  }
}

export interface UciProcessOptions {
  readonly binary: string;
  readonly args?: readonly string[];
  readonly threads?: number;
  readonly hashMb?: number;
  readonly timeoutMs?: number;
}

/** One resource-limited UCI process. The service pool guarantees one request at a time. */
export class UciProcessWorker implements AnalysisWorker {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #lines: LineReader;
  readonly #timeoutMs: number;

  private constructor(process: ChildProcessWithoutNullStreams, timeoutMs: number) {
    this.#process = process;
    this.#lines = new LineReader(process);
    this.#timeoutMs = timeoutMs;
  }

  static async create(options: UciProcessOptions): Promise<UciProcessWorker> {
    const process = spawn(options.binary, [...(options.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: processEnvPath() }
    });
    const worker = new UciProcessWorker(process, options.timeoutMs ?? 30_000);
    worker.#send("uci");
    await worker.#readUntil("uciok");
    worker.#send(`setoption name Threads value ${boundedInteger(options.threads ?? 1, 1, 16, "threads")}`);
    worker.#send(`setoption name Hash value ${boundedInteger(options.hashMb ?? 64, 1, 2_048, "hashMb")}`);
    worker.#send("isready");
    await worker.#readUntil("readyok");
    return worker;
  }

  async analyze(input: AnalysisRequest): Promise<EngineAnalysis> {
    const request = validateRequest(input);
    this.#send(`setoption name MultiPV value ${request.multiPv}`);
    this.#send(`position fen ${request.fen}`);
    this.#send(`go depth ${request.depth}`);
    const lines: string[] = [];
    try {
      for (;;) {
        const line = await this.#lines.next(this.#timeoutMs);
        lines.push(line);
        if (line.startsWith("bestmove ")) break;
      }
    } catch (error) {
      this.#send("stop");
      throw error;
    }
    return parseUciAnalysis(request, lines);
  }

  async dispose(): Promise<void> {
    this.#send("quit");
    await new Promise<void>((resolve) => {
      if (this.#process.exitCode !== null) resolve();
      else this.#process.once("exit", () => resolve());
    });
  }

  #send(command: string): void {
    if (!this.#process.stdin.write(`${command}\n`)) {
      throw new EngineServiceError("PROCESS_FAILURE", "Stockfish input stream is unavailable");
    }
  }

  async #readUntil(expected: string): Promise<void> {
    for (;;) if ((await this.#lines.next(this.#timeoutMs)) === expected) return;
  }
}

export function parseUciAnalysis(request: AnalysisRequest, lines: readonly string[]): EngineAnalysis {
  const variations = new Map<number, PrincipalVariation>();
  let bestMove: UciMove | undefined;
  for (const line of lines) {
    if (line.startsWith("bestmove ")) {
      const value = line.split(/\s+/)[1];
      if (value !== undefined && value !== "(none)" && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value)) bestMove = value as UciMove;
      continue;
    }
    if (!line.startsWith("info ")) continue;
    const tokens = line.split(/\s+/);
    const depth = numberAfter(tokens, "depth");
    const scoreAt = tokens.indexOf("score");
    const pvAt = tokens.indexOf("pv");
    if (depth === undefined || scoreAt < 0 || pvAt < 0) continue;
    const scoreType = tokens[scoreAt + 1];
    const scoreValue = Number.parseInt(tokens[scoreAt + 2] ?? "", 10);
    if ((scoreType !== "cp" && scoreType !== "mate") || !Number.isFinite(scoreValue)) continue;
    const rank = numberAfter(tokens, "multipv") ?? 1;
    const moves = tokens.slice(pvAt + 1).filter((move) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) as UciMove[];
    variations.set(rank, {
      rank,
      depth,
      score: scoreType === "cp" ? { type: "centipawn", value: scoreValue } : { type: "mate", value: scoreValue },
      moves
    });
  }
  const ordered = [...variations.values()].sort((a, b) => a.rank - b.rank).slice(0, request.multiPv);
  if (ordered.length === 0) throw new EngineServiceError("PROCESS_FAILURE", "Stockfish returned no principal variation");
  return {
    fen: request.fen,
    perspective: request.fen.split(" ")[1] === "w" ? "white" : "black",
    depth: Math.max(...ordered.map(({ depth }) => depth)),
    variations: ordered,
    ...(bestMove === undefined ? {} : { bestMove })
  };
}

class LineReader {
  readonly #queue: string[] = [];
  readonly #waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  #buffer = "";
  #failure?: Error;

  constructor(process: ChildProcessWithoutNullStreams) {
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => this.#push(chunk));
    process.once("error", (error) => this.#fail(error));
    process.once("exit", (code) => this.#fail(new EngineServiceError("PROCESS_FAILURE", `Stockfish exited with code ${code ?? "unknown"}`)));
  }

  next(timeoutMs: number): Promise<string> {
    const line = this.#queue.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new EngineServiceError("TIMEOUT", "Stockfish response timed out"));
      }, timeoutMs);
      this.#waiters.push({ resolve, reject, timer });
    });
  }

  #push(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#queue.push(line);
      else {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
    }
  }

  #fail(error: Error): void {
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function validateRequest(input: AnalysisRequest): AnalysisRequest {
  return {
    fen: parseFen(input.fen),
    depth: boundedInteger(input.depth, 1, 30, "depth"),
    multiPv: boundedInteger(input.multiPv, 1, 5, "multiPv")
  };
}

function cacheKey(request: AnalysisRequest): string {
  return `${request.fen}|depth=${request.depth}|multipv=${request.multiPv}`;
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new EngineServiceError("INVALID_REQUEST", `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function numberAfter(tokens: readonly string[], key: string): number | undefined {
  const index = tokens.indexOf(key);
  if (index < 0) return undefined;
  const parsed = Number.parseInt(tokens[index + 1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function processEnvPath(): string {
  return process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
}

