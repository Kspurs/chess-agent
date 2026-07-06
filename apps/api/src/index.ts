import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { AgentRunResult } from "@chess-agent/agent-runtime";
import { EVENT_PROTOCOL_VERSION, type PlatformEvent } from "@chess-agent/event-protocol";
import type { EventId, SessionId, UserId } from "@chess-agent/shared-types";
import type { LichessOAuthCoordinator } from "./oauth.js";

export interface Authenticator {
  authenticate(authorization: string | undefined): Promise<UserId | undefined>;
}

export interface AgentRunRequest {
  readonly requestId: string;
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly message: string;
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
  watchReview?(userId: UserId, sessionId: SessionId, jobId: string, events: SessionEventStore): void;
  close?(): Promise<void>;
}

export interface GameSyncService {
  watch(userId: UserId, sessionId: SessionId, gameId: string, events: SessionEventStore): void;
  close(): Promise<void>;
}

export interface ApiOptions {
  readonly authenticate: Authenticator;
  readonly agent: AgentRunner;
  readonly eventStore?: SessionEventStore;
  readonly rateLimitPerMinute?: number;
  readonly now?: () => Date;
  readonly lichessOAuth?: LichessOAuthCoordinator;
  readonly onInternalError?: (error: unknown) => void;
  readonly gameSync?: GameSyncService;
  readonly localSessionToken?: string;
  readonly connectionStatus?: (userId: UserId) => Promise<{ readonly lichessConnected: boolean; readonly username?: string }>;
}

export function createApi(options: ApiOptions): FastifyInstance {
  const app = Fastify({ logger: false, genReqId: () => randomUUID() });
  const events = options.eventStore ?? new SessionEventStore();
  const owners = new Map<SessionId, UserId>();
  const limiter = new UserRateLimiter(options.rateLimitPerMinute ?? 30, options.now);

  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof ApiHttpError ? error.status : 500;
    if (status === 500) options.onInternalError?.(error);
    const code = error instanceof ApiHttpError ? error.code : "INTERNAL";
    const message = status === 500 ? "Internal server error" : error instanceof Error ? error.message : "Request failed";
    void reply.status(status).send({ error: { code, message } });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/v1/local/session", async (_request, reply) => {
    if (options.localSessionToken === undefined) throw new ApiHttpError(503, "NOT_CONFIGURED", "Local login is not configured");
    reply.header("set-cookie", `chess_agent_session=${encodeURIComponent(options.localSessionToken)}; HttpOnly; SameSite=Strict; Path=/`);
    return { ready: true };
  });

  app.get("/v1/connection", async (request) => {
    const userId = await requireUser(request, options.authenticate);
    return options.connectionStatus?.(userId) ?? { lichessConnected: false };
  });

  app.get("/v1/oauth/lichess/start", async (request) => {
    if (options.lichessOAuth === undefined) throw new ApiHttpError(503, "NOT_CONFIGURED", "Lichess OAuth is not configured");
    const userId = await requireUser(request, options.authenticate);
    return { authorizationUrl: options.lichessOAuth.start(userId) };
  });

  app.get<{ Querystring: { code?: string; state?: string } }>("/v1/oauth/lichess/callback", async (request, reply) => {
    if (options.lichessOAuth === undefined) throw new ApiHttpError(503, "NOT_CONFIGURED", "Lichess OAuth is not configured");
    const code = requireString(request.query.code, "code", 1, 1_024);
    const state = requireString(request.query.state, "state", 1, 1_024);
    const completed = await options.lichessOAuth.complete(code, state);
    return reply.redirect(completed.redirectTo);
  });

  app.post("/v1/agent/runs", async (request, reply) => {
    const userId = await requireUser(request, options.authenticate);
    if (!limiter.take(userId)) throw new ApiHttpError(429, "RATE_LIMITED", "Too many requests");
    const body = requireRecord(request.body);
    const message = requireString(body.message, "message", 1, 20_000);
    const sessionId = body.sessionId === undefined
      ? randomUUID() as SessionId
      : requireString(body.sessionId, "sessionId", 1, 128) as SessionId;
    const owner = owners.get(sessionId);
    if (owner !== undefined && owner !== userId) throw new ApiHttpError(403, "FORBIDDEN", "Session belongs to another user");
    owners.set(sessionId, userId);

    const result = await options.agent.run({ requestId: request.id, userId, sessionId, message });
    publishToolEvents(events, sessionId, userId, result);
    for (const gameId of activeGameReferences(result)) options.gameSync?.watch(userId, sessionId, gameId, events);
    for (const jobId of startedReviewReferences(result)) options.agent.watchReview?.(userId, sessionId, jobId, events);
    events.publish(sessionId, "agent.message.delta", { text: result.message });
    events.publish(sessionId, "agent.message.completed", { messageId: randomUUID() });
    for (const action of result.actions) {
      if (action.resourceId === undefined) continue;
      const panel = action.type === "open_game" ? "game" : action.type === "open_review" ? "review" : action.type === "open_puzzle" ? "puzzle" : undefined;
      if (panel !== undefined) events.publish(sessionId, "ui.open_panel", { panel, resourceId: action.resourceId });
    }
    return reply.status(200).send({ sessionId, result });
  });

  app.get<{ Params: { sessionId: string }; Querystring: { after?: string } }>(
    "/v1/sessions/:sessionId/events/snapshot",
    async (request) => {
      const userId = await requireUser(request, options.authenticate);
      const sessionId = requireOwnedSession(request.params.sessionId, userId, owners);
      const after = parseSequence(request.query.after);
      return { events: events.list(sessionId, after) };
    }
  );

  app.get<{ Params: { sessionId: string }; Querystring: { after?: string } }>(
    "/v1/sessions/:sessionId/events",
    async (request, reply) => {
      const userId = await requireUser(request, options.authenticate);
      const sessionId = requireOwnedSession(request.params.sessionId, userId, owners);
      const after = parseSequence(request.query.after ?? request.headers["last-event-id"]);
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive"
      });
      for (const event of events.list(sessionId, after)) writeSse(reply.raw, event);
      const unsubscribe = events.subscribe(sessionId, (event) => writeSse(reply.raw, event));
      const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
      request.raw.once("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    }
  );

  app.addHook("onClose", async () => {
    await options.gameSync?.close();
    await options.agent.close?.();
  });

  return app;
}

export * from "./oauth.js";

export class SessionEventStore {
  readonly #events = new Map<SessionId, PlatformEvent[]>();
  readonly #listeners = new Map<SessionId, Set<(event: PlatformEvent) => void>>();

  constructor(initial: Readonly<Record<string, readonly PlatformEvent[]>> = {}, private readonly persist?: (event: PlatformEvent) => Promise<void>) {
    for (const [sessionId, values] of Object.entries(initial)) this.#events.set(sessionId as SessionId, [...values]);
  }

  publish<Type extends PlatformEvent["type"]>(sessionId: SessionId, type: Type, payload: Extract<PlatformEvent, { type: Type }>["payload"]): PlatformEvent {
    const values = this.#events.get(sessionId) ?? [];
    const event = {
      version: EVENT_PROTOCOL_VERSION,
      id: randomUUID() as EventId,
      sessionId,
      sequence: (values.at(-1)?.sequence ?? 0) + 1,
      occurredAt: new Date().toISOString(),
      type,
      payload
    } as PlatformEvent;
    values.push(event);
    this.#events.set(sessionId, values.slice(-1_000));
    void this.persist?.(event).catch(() => undefined);
    for (const listener of this.#listeners.get(sessionId) ?? []) listener(event);
    return event;
  }

  list(sessionId: SessionId, afterSequence = 0): readonly PlatformEvent[] {
    return (this.#events.get(sessionId) ?? []).filter(({ sequence }) => sequence > afterSequence);
  }

  subscribe(sessionId: SessionId, listener: (event: PlatformEvent) => void): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);
    return () => listeners.delete(listener);
  }
}

class UserRateLimiter {
  readonly #requests = new Map<UserId, number[]>();
  readonly #now: () => Date;

  constructor(private readonly limit: number, now: (() => Date) | undefined) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("rate limit must be positive");
    this.#now = now ?? (() => new Date());
  }

  take(userId: UserId): boolean {
    const cutoff = this.#now().getTime() - 60_000;
    const recent = (this.#requests.get(userId) ?? []).filter((time) => time > cutoff);
    if (recent.length >= this.limit) return false;
    recent.push(this.#now().getTime());
    this.#requests.set(userId, recent);
    return true;
  }
}

class ApiHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function requireUser(request: FastifyRequest, authenticator: Authenticator): Promise<UserId> {
  const value = request.headers.authorization;
  const header = Array.isArray(value) ? value[0] : value;
  const cookieToken = parseCookie(request.headers.cookie, "chess_agent_session");
  const user = await authenticator.authenticate(header ?? (cookieToken === undefined ? undefined : `Bearer ${cookieToken}`));
  if (user === undefined) throw new ApiHttpError(401, "UNAUTHENTICATED", "Authentication required");
  return user;
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  const value = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  if (value === undefined) return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}

function requireOwnedSession(value: string, userId: UserId, owners: Map<SessionId, UserId>): SessionId {
  const sessionId = requireString(value, "sessionId", 1, 128) as SessionId;
  if (owners.get(sessionId) !== userId) throw new ApiHttpError(404, "NOT_FOUND", "Session was not found");
  return sessionId;
}

function parseSequence(value: string | string[] | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number.parseInt(Array.isArray(value) ? value[0] ?? "" : value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ApiHttpError(400, "BAD_REQUEST", "Invalid event cursor");
  return parsed;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ApiHttpError(400, "BAD_REQUEST", "Request body must be an object");
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) throw new ApiHttpError(400, "BAD_REQUEST", `${name} is invalid`);
  return value;
}

function writeSse(stream: NodeJS.WritableStream, event: PlatformEvent): void {
  stream.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function publishToolEvents(events: SessionEventStore, sessionId: SessionId, userId: UserId, result: AgentRunResult): void {
  const calls = new Map<string, { name: string; arguments: unknown }>();
  for (const message of result.messages) {
    if (message.role === "assistant") for (const call of message.toolCalls ?? []) calls.set(call.id, call);
  }
  for (const message of result.messages) {
    if (message.role !== "tool") continue;
    try {
      const resultValue = JSON.parse(message.content) as unknown;
      if (typeof resultValue !== "object" || resultValue === null || !(resultValue as Record<string, unknown>).ok) continue;
      const value = (resultValue as { value?: unknown }).value;
      if (typeof value !== "object" || value === null) continue;
      const call = calls.get(message.toolCallId);
      const args = typeof call?.arguments === "object" && call.arguments !== null ? call.arguments as Record<string, unknown> : {};
      if (message.name === "create_puzzle" && typeof (value as Record<string, unknown>).puzzleId === "string") {
        const puzzle = (value as Record<string, unknown>).puzzle;
        if (typeof puzzle === "object" && puzzle !== null) {
          const record = puzzle as Record<string, unknown>;
          if (typeof record.initialFen === "string" && typeof record.rating === "number" && Array.isArray(record.themes)) {
            events.publish(sessionId, "puzzle.started", {
              puzzleId: (value as { puzzleId: string }).puzzleId as never,
              fen: record.initialFen,
              rating: record.rating,
              themes: record.themes.filter((theme): theme is string => typeof theme === "string")
            });
          }
        }
      }
      if (message.name === "submit_puzzle_move" && typeof args.puzzleId === "string") {
        const record = value as Record<string, unknown>;
        if (typeof record.correct === "boolean" && typeof record.message === "string") {
          events.publish(sessionId, "puzzle.feedback", {
            puzzleId: args.puzzleId as never,
            correct: record.correct,
            message: record.message
          });
        }
      }
      if (message.name === "get_review") {
        const record = value as Record<string, unknown>;
        const review = record.result;
        if (record.status === "succeeded" && typeof record.id === "string" && typeof review === "object" && review !== null && typeof (review as Record<string, unknown>).id === "string") {
          const reviewRecord = review as Record<string, unknown>;
          events.publish(sessionId, "analysis.completed", {
            jobId: record.id as never,
            reviewId: (review as { id: string }).id as never
          });
          if (typeof reviewRecord.gameId === "string" && Array.isArray(reviewRecord.criticalMoments)) {
            events.publish(sessionId, "review.completed", {
              reviewId: reviewRecord.id as never,
              gameId: reviewRecord.gameId as never,
              criticalMoments: reviewRecord.criticalMoments as never
            });
          }
        }
      }
      const game = (value as Record<string, unknown>).game;
      if (typeof game !== "object" || game === null) continue;
      const record = game as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.currentFen !== "string") continue;
      const moves = Array.isArray(record.moves) ? record.moves : [];
      const lastMove = moves.length > 0 && typeof moves.at(-1) === "object" && moves.at(-1) !== null
        ? (moves.at(-1) as Record<string, unknown>).uci
        : undefined;
      events.publish(sessionId, "board.position_changed", {
        gameId: record.id as never,
        fen: record.currentFen,
        ...(typeof lastMove === "string" ? { lastMove } : {}),
        moves: moves.flatMap((move) => {
          if (typeof move !== "object" || move === null) return [];
          const value = move as Record<string, unknown>;
          return typeof value.san === "string" && typeof value.uci === "string" ? [{ san: value.san, uci: value.uci }] : [];
        }),
        ...(typeof record.status === "string" ? { status: record.status } : {}),
        ...(record.blackUserId === userId ? { orientation: "black" as const } : { orientation: "white" as const })
      });
    } catch {
      // Tool messages are internal JSON; malformed content simply emits no board event.
    }
  }
}

function activeGameReferences(result: AgentRunResult): string[] {
  const ids = new Set<string>();
  for (const message of result.messages) {
    if (message.role !== "tool") continue;
    try {
      const parsed = JSON.parse(message.content) as { ok?: boolean; value?: { game?: Record<string, unknown> } };
      const game = parsed.ok ? parsed.value?.game : undefined;
      if (typeof game?.id === "string" && (game.status === "started" || game.status === "created")) ids.add(game.id);
    } catch {
      // Ignore malformed internal tool messages.
    }
  }
  return [...ids];
}

function startedReviewReferences(result: AgentRunResult): string[] {
  const ids = new Set<string>();
  for (const message of result.messages) {
    if (message.role !== "tool" || message.name !== "review_game") continue;
    try {
      const parsed = JSON.parse(message.content) as { ok?: boolean; value?: { jobId?: unknown } };
      if (parsed.ok && typeof parsed.value?.jobId === "string") ids.add(parsed.value.jobId);
    } catch {
      // Ignore malformed internal tool messages.
    }
  }
  return [...ids];
}
