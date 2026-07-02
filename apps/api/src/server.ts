import { readFile } from "node:fs/promises";
import {
  AgentRuntime,
  MemoryTraceSink,
  OpenAIResponsesModel,
  type AgentMessage,
  type AgentRunResult
} from "@chess-agent/agent-runtime";
import {
  AgentToolExecutor,
  MemoryAuditSink,
  type AgentSession
} from "@chess-agent/agent-tools";
import type { Fen, UciMove } from "@chess-agent/chess-domain";
import {
  EncryptedLichessCredentialStore,
  LichessPlatform,
  type EncryptedRecordStore
} from "@chess-agent/platform-adapter";
import { StockfishAnalysisService, UciProcessWorker } from "@chess-agent/engine";
import { GameReviewService } from "@chess-agent/review";
import { InMemoryPuzzleRepository, PuzzleService } from "@chess-agent/puzzle";
import type { PuzzleId, SessionId, UserId } from "@chess-agent/shared-types";
import { createApi, type AgentRunRequest, type AgentRunner, type Authenticator } from "./index.js";
import { LichessOAuthCoordinator } from "./oauth.js";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly appToken: string;
  readonly appUserId: UserId;
  readonly openAiApiKey: string;
  readonly openAiModel: string;
  readonly lichessClientId: string;
  readonly lichessRedirectUri: string;
  readonly credentialEncryptionKey: Uint8Array;
  readonly stockfishPath: string;
}

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const key = Buffer.from(required(env, "CREDENTIAL_ENCRYPTION_KEY_BASE64"), "base64");
  if (key.byteLength !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
  const port = Number.parseInt(env.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid");
  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    appToken: required(env, "APP_TOKEN"),
    appUserId: required(env, "APP_USER_ID") as UserId,
    openAiApiKey: required(env, "OPENAI_API_KEY"),
    openAiModel: env.OPENAI_MODEL ?? "gpt-5.4-mini",
    lichessClientId: required(env, "LICHESS_CLIENT_ID"),
    lichessRedirectUri: required(env, "LICHESS_REDIRECT_URI"),
    credentialEncryptionKey: key,
    stockfishPath: required(env, "STOCKFISH_PATH")
  };
}

export async function createConfiguredApi(config: ServerConfig) {
  const records = new MemoryEncryptedRecords();
  const credentials = new EncryptedLichessCredentialStore(records, config.credentialEncryptionKey);
  const worker = await UciProcessWorker.create({ binary: config.stockfishPath, threads: 1, hashMb: 128 });
  const engine = new StockfishAnalysisService([worker]);
  const puzzleRepository = new InMemoryPuzzleRepository();
  puzzleRepository.import(developmentPuzzles);
  const puzzles = new PuzzleService(puzzleRepository);
  const model = new OpenAIResponsesModel({ apiKey: config.openAiApiKey, model: config.openAiModel });
  const policy = await readFile(new URL("../../../prompts/system.md", import.meta.url), "utf8");
  const skills = await Promise.all(["game-control", "game-review", "puzzle-session"].map((name) =>
    readFile(new URL(`../../../prompts/skills/${name}.md`, import.meta.url), "utf8")
  ));
  const runner = new ConfiguredAgentRunner(model, credentials, engine, puzzles, policy, skills);
  const authenticator: Authenticator = {
    authenticate: async (authorization) => authorization === `Bearer ${config.appToken}` ? config.appUserId : undefined
  };
  const oauth = new LichessOAuthCoordinator({
    clientId: config.lichessClientId,
    redirectUri: config.lichessRedirectUri,
    credentials
  });
  return createApi({ authenticate: authenticator, agent: runner, lichessOAuth: oauth });
}

class ConfiguredAgentRunner implements AgentRunner {
  readonly #sessions = new Map<SessionId, AgentSession>();
  readonly #history = new Map<SessionId, AgentMessage[]>();
  readonly #reviews = new Map<UserId, GameReviewService>();
  readonly #audit = new MemoryAuditSink();

  constructor(
    private readonly model: OpenAIResponsesModel,
    private readonly credentials: EncryptedLichessCredentialStore,
    private readonly engine: StockfishAnalysisService,
    private readonly puzzles: PuzzleService,
    private readonly policy: string,
    private readonly skills: readonly string[]
  ) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const platform = new LichessPlatform({ credentials: this.credentials, userId: request.userId });
    const reviews = this.#reviews.get(request.userId) ?? new GameReviewService(platform, this.engine);
    this.#reviews.set(request.userId, reviews);
    const session = this.#sessions.get(request.sessionId) ?? { id: request.sessionId, mode: "idle" as const };
    const tools = new AgentToolExecutor({
      requestId: request.requestId,
      userId: request.userId,
      session,
      platform,
      reviews,
      puzzles: this.puzzles,
      audit: this.#audit
    });
    const runtime = new AgentRuntime(this.model, tools, new MemoryTraceSink(), {
      systemPolicy: this.policy,
      skills: this.skills,
      maxSteps: 8,
      maxTokens: 24_000,
      timeoutMs: 45_000
    });
    const result = await runtime.run(request.message, this.#history.get(request.sessionId) ?? []);
    this.#history.set(request.sessionId, result.messages.slice(-100));
    this.#sessions.set(request.sessionId, updateSession(session, result));
    return result;
  }
}

class MemoryEncryptedRecords implements EncryptedRecordStore {
  readonly #values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.#values.get(key); }
  async set(key: string, value: string): Promise<void> { this.#values.set(key, value); }
  async delete(key: string): Promise<void> { this.#values.delete(key); }
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
