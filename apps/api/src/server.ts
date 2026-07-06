import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AgentRuntime,
  MemoryTraceSink,
  OllamaChatModel,
  OpenAIResponsesModel,
  type AgentModel,
  type AgentMessage,
  type AgentRunResult
} from "@chess-agent/agent-runtime";
import {
  AgentToolExecutor,
  type AuditSink,
  type AgentSession
} from "@chess-agent/agent-tools";
import type { Fen, UciMove } from "@chess-agent/chess-domain";
import { EncryptedLichessCredentialStore, LichessPlatform } from "@chess-agent/platform-adapter";
import { StockfishAnalysisService, UciProcessWorker } from "@chess-agent/engine";
import { GameReviewService, type ReviewArtifact, type ReviewArtifactRepository } from "@chess-agent/review";
import { InMemoryPuzzleRepository, PuzzleService, parseLichessPuzzleCsv } from "@chess-agent/puzzle";
import type { JobId, PuzzleId, SessionId, UserId } from "@chess-agent/shared-types";
import {
  createApi,
  SessionEventStore,
  type AgentRunRequest,
  type AgentRunner,
  type Authenticator,
  type GameSyncService
} from "./index.js";
import { LichessOAuthCoordinator } from "./oauth.js";
import { FileStateStore, type AgentStateRepository } from "./file-store.js";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly appToken: string;
  readonly appUserId: UserId;
  readonly modelProvider: "ollama" | "openai";
  readonly modelName: string;
  readonly modelBaseUrl: string;
  readonly openAiApiKey?: string;
  readonly lichessClientId: string;
  readonly lichessRedirectUri: string;
  readonly credentialEncryptionKey: Uint8Array;
  readonly stockfishPath: string;
  readonly dataDirectory: string;
  readonly puzzleDataPath?: string;
}

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const key = Buffer.from(required(env, "CREDENTIAL_ENCRYPTION_KEY_BASE64"), "base64");
  if (key.byteLength !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
  const port = Number.parseInt(env.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid");
  const modelProvider = env.MODEL_PROVIDER === "openai" ? "openai" : "ollama";
  const openAiApiKey = env.OPENAI_API_KEY;
  if (modelProvider === "openai" && !openAiApiKey) throw new Error("OPENAI_API_KEY is required when MODEL_PROVIDER=openai");
  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    appToken: required(env, "APP_TOKEN"),
    appUserId: required(env, "APP_USER_ID") as UserId,
    modelProvider,
    modelName: env.MODEL_NAME ?? (modelProvider === "ollama" ? "qwen3:4b" : "gpt-5.4-mini"),
    modelBaseUrl: env.MODEL_BASE_URL ?? "http://127.0.0.1:11434",
    ...(openAiApiKey === undefined ? {} : { openAiApiKey }),
    lichessClientId: required(env, "LICHESS_CLIENT_ID"),
    lichessRedirectUri: required(env, "LICHESS_REDIRECT_URI"),
    credentialEncryptionKey: key,
    stockfishPath: required(env, "STOCKFISH_PATH"),
    dataDirectory: resolve(env.DATA_DIR ?? "./data"),
    ...(env.PUZZLE_DATA_PATH === undefined ? {} : { puzzleDataPath: resolve(env.PUZZLE_DATA_PATH) })
  };
}

export async function createConfiguredApi(config: ServerConfig) {
  const state = new FileStateStore(resolve(config.dataDirectory, "state.json"));
  const credentials = new EncryptedLichessCredentialStore(state, config.credentialEncryptionKey);
  const worker = await UciProcessWorker.create({ binary: config.stockfishPath, threads: 1, hashMb: 128 });
  const engine = new StockfishAnalysisService([worker], state);
  const puzzleRepository = new InMemoryPuzzleRepository();
  if (config.puzzleDataPath === undefined) puzzleRepository.import(developmentPuzzles);
  else puzzleRepository.import(parseLichessPuzzleCsv(await readFile(config.puzzleDataPath, "utf8")));
  const puzzles = new PuzzleService(puzzleRepository, () => new Date(), state);
  await puzzles.initialize();
  const model: AgentModel = config.modelProvider === "ollama"
    ? new OllamaChatModel({ model: config.modelName, baseUrl: config.modelBaseUrl, contextLength: 8_192 })
    : new OpenAIResponsesModel({ apiKey: config.openAiApiKey!, model: config.modelName });
  const policy = await readFile(new URL("../../../prompts/system.md", import.meta.url), "utf8");
  const skills = await Promise.all(["game-control", "game-review", "puzzle-session"].map((name) =>
    readFile(new URL(`../../../prompts/skills/${name}.md`, import.meta.url), "utf8")
  ));
  const runner = new ConfiguredAgentRunner(
    model,
    credentials,
    engine,
    puzzles,
    policy,
    skills,
    state,
    state,
    config.modelProvider === "ollama" ? 300_000 : 45_000
  );
  const authenticator: Authenticator = {
    authenticate: async (authorization) => authorization === `Bearer ${config.appToken}` ? config.appUserId : undefined
  };
  const oauth = new LichessOAuthCoordinator({
    clientId: config.lichessClientId,
    redirectUri: config.lichessRedirectUri,
    credentials
  });
  const events = new SessionEventStore(await state.loadSessionEvents(), (event) => state.saveEvent(event));
  const gameSync = new LichessGameSyncService(credentials);
  return createApi({
    authenticate: authenticator,
    agent: runner,
    lichessOAuth: oauth,
    eventStore: events,
    gameSync,
    localSessionToken: config.appToken,
    connectionStatus: async (userId) => {
      const credential = await credentials.get(userId);
      return credential === undefined ? { lichessConnected: false } : { lichessConnected: true, username: credential.username };
    },
    onInternalError: (error) => console.error("API request failed", error)
  });
}

class LichessGameSyncService implements GameSyncService {
  readonly #watchers = new Map<string, AbortController>();

  constructor(private readonly credentials: EncryptedLichessCredentialStore) {}

  watch(userId: UserId, sessionId: SessionId, gameId: string, events: SessionEventStore): void {
    const key = `${sessionId}:${gameId}`;
    if (this.#watchers.has(key)) return;
    const controller = new AbortController();
    this.#watchers.set(key, controller);
    const platform = new LichessPlatform({ credentials: this.credentials, userId });
    void this.#run(platform, sessionId, gameId, events, controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.error("Lichess game synchronization failed", error);
      })
      .finally(() => this.#watchers.delete(key));
  }

  async close(): Promise<void> {
    for (const controller of this.#watchers.values()) controller.abort();
    this.#watchers.clear();
  }

  async #run(platform: LichessPlatform, sessionId: SessionId, gameId: string, events: SessionEventStore, signal: AbortSignal): Promise<void> {
    let retryMs = 1_000;
    while (!signal.aborted) {
      let completed = false;
      try {
        await platform.watchGame(gameId as never, (update) => {
          events.publish(sessionId, "board.position_changed", {
            gameId: update.gameId,
            fen: update.fen,
            ...(update.lastMove === undefined ? {} : { lastMove: update.lastMove }),
            moves: update.moves,
            status: update.status
          });
          if (update.whiteMs !== undefined && update.blackMs !== undefined) {
            events.publish(sessionId, "game.clock_changed", {
              gameId: update.gameId,
              whiteMs: update.whiteMs,
              blackMs: update.blackMs,
              running: update.running ?? null
            });
          }
          if (update.status !== "started" && update.status !== "created") {
            completed = true;
            events.publish(sessionId, "game.completed", { gameId: update.gameId, result: update.result });
          }
        }, signal);
        if (completed || signal.aborted) return;
      } catch (error) {
        if (signal.aborted) return;
        console.error("Lichess stream disconnected; reconnecting", error);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, retryMs);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      retryMs = Math.min(retryMs * 2, 30_000);
    }
  }
}

class ConfiguredAgentRunner implements AgentRunner {
  readonly #sessions = new Map<SessionId, AgentSession>();
  readonly #history = new Map<SessionId, AgentMessage[]>();
  readonly #reviews = new Map<UserId, GameReviewService>();
  readonly #reviewWatchers = new Map<string, AbortController>();

  constructor(
    private readonly model: AgentModel,
    private readonly credentials: EncryptedLichessCredentialStore,
    private readonly engine: StockfishAnalysisService,
    private readonly puzzles: PuzzleService,
    private readonly policy: string,
    private readonly skills: readonly string[],
    private readonly state: AgentStateRepository & ReviewArtifactRepository,
    private readonly audit: AuditSink,
    private readonly timeoutMs: number
  ) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const platform = new LichessPlatform({ credentials: this.credentials, userId: request.userId });
    const reviews = this.#reviews.get(request.userId) ?? new GameReviewService(platform, this.engine, {}, this.state);
    this.#reviews.set(request.userId, reviews);
    const stored = await this.state.load(request.userId, request.sessionId);
    const session = this.#sessions.get(request.sessionId) ?? stored?.session ?? { id: request.sessionId, mode: "idle" as const };
    const tools = new AgentToolExecutor({
      requestId: request.requestId,
      userId: request.userId,
      session,
      platform,
      reviews,
      puzzles: this.puzzles,
      audit: this.audit
    });
    const runtime = new AgentRuntime(this.model, tools, new MemoryTraceSink(), {
      systemPolicy: this.policy,
      skills: this.skills,
      maxSteps: 8,
      maxTokens: 24_000,
      timeoutMs: this.timeoutMs
    });
    const result = await runtime.run(request.message, this.#history.get(request.sessionId) ?? stored?.history ?? []);
    const history = result.messages.slice(-100);
    const updatedSession = updateSession(session, result);
    this.#history.set(request.sessionId, history);
    this.#sessions.set(request.sessionId, updatedSession);
    await this.state.save(request.userId, { session: updatedSession, history });
    return result;
  }

  watchReview(userId: UserId, sessionId: SessionId, rawJobId: string, events: SessionEventStore): void {
    const key = `${sessionId}:${rawJobId}`;
    if (this.#reviewWatchers.has(key)) return;
    const reviews = this.#reviews.get(userId);
    if (reviews === undefined) return;
    const controller = new AbortController();
    this.#reviewWatchers.set(key, controller);
    void this.#pollReview(reviews, rawJobId as JobId, sessionId, events, controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.error("Review progress synchronization failed", error);
      })
      .finally(() => this.#reviewWatchers.delete(key));
  }

  async close(): Promise<void> {
    for (const controller of this.#reviewWatchers.values()) controller.abort();
    this.#reviewWatchers.clear();
  }

  async #pollReview(reviews: GameReviewService, jobId: JobId, sessionId: SessionId, events: SessionEventStore, signal: AbortSignal): Promise<void> {
    let lastProgress = -1;
    while (!signal.aborted) {
      const job = await reviews.getJob(jobId);
      if (job.progress !== lastProgress) {
        lastProgress = job.progress;
        events.publish(sessionId, "analysis.progress", { jobId, progress: job.progress });
      }
      if (job.status === "succeeded" && job.result !== undefined) {
        this.#publishCompletedReview(jobId, job.result, sessionId, events);
        return;
      }
      if (job.status === "failed") {
        events.publish(sessionId, "analysis.failed", { jobId, message: job.error?.message ?? "Review failed" });
        return;
      }
      await abortableDelay(500, signal);
    }
  }

  #publishCompletedReview(jobId: JobId, review: ReviewArtifact, sessionId: SessionId, events: SessionEventStore): void {
    events.publish(sessionId, "analysis.completed", { jobId, reviewId: review.id });
    events.publish(sessionId, "review.completed", {
      reviewId: review.id,
      gameId: review.gameId,
      criticalMoments: review.criticalMoments
    });
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function updateSession(current: AgentSession, result: AgentRunResult): AgentSession {
  let next = current;
  for (const message of result.messages) {
    if (message.role !== "tool") continue;
    try {
      const parsed = JSON.parse(message.content) as { ok?: boolean; value?: Record<string, unknown> };
      if (!parsed.ok || parsed.value === undefined) continue;
      const game = parsed.value.game;
      if (typeof game === "object" && game !== null && typeof (game as Record<string, unknown>).id === "string") {
        next = {
          id: current.id,
          mode: (game as Record<string, unknown>).status === "started" ? "playing" : "idle",
          activeGameId: (game as Record<string, unknown>).id as never
        };
      } else if (typeof parsed.value.puzzleId === "string") {
        next = {
          id: current.id,
          mode: "puzzle",
          activePuzzleId: parsed.value.puzzleId as PuzzleId,
          ...(current.activeGameId === undefined ? {} : { activeGameId: current.activeGameId })
        };
      }
    } catch {
      // Ignore malformed internal trace data when deriving convenience session state.
    }
  }
  return next;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const developmentPuzzles = [
  {
    id: "dev_opening_1" as PuzzleId,
    initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" as Fen,
    solution: ["e2e4", "e7e5", "g1f3"] as UciMove[],
    rating: 800,
    themes: ["development"],
    source: "Chess Agent development fixture",
    license: "CC0-1.0"
  }
] as const;
