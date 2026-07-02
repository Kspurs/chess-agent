import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  ChessRules,
  type ChessGame,
  type Color,
  type GameResult,
  type GameStatus,
  type Pgn
} from "@chess-agent/chess-domain";
import type { GameId, Page, PageRequest, UserId } from "@chess-agent/shared-types";
import {
  PlatformError,
  type ChessPlatform,
  type CreateGameOptions,
  type VersionedGame
} from "./index.js";

const DEFAULT_BASE_URL = "https://lichess.org";

export interface LichessCredential {
  readonly username: string;
  readonly accessToken: string;
}

export interface LichessCredentialStore {
  get(userId: UserId): Promise<LichessCredential | undefined>;
  set(userId: UserId, credential: LichessCredential): Promise<void>;
  delete(userId: UserId): Promise<void>;
}

export interface EncryptedRecordStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** AES-256-GCM envelope encryption; the backing store never receives plaintext tokens. */
export class EncryptedLichessCredentialStore implements LichessCredentialStore {
  constructor(
    private readonly records: EncryptedRecordStore,
    private readonly encryptionKey: Uint8Array
  ) {
    if (encryptionKey.byteLength !== 32) throw new RangeError("Lichess credential encryption key must be 32 bytes");
  }

  async get(userId: UserId): Promise<LichessCredential | undefined> {
    const encoded = await this.records.get(userId);
    if (encoded === undefined) return undefined;
    const envelope = JSON.parse(encoded) as { iv: string; ciphertext: string; tag: string };
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
    return validateCredential(JSON.parse(plaintext));
  }

  async set(userId: UserId, credential: LichessCredential): Promise<void> {
    const valid = validateCredential(credential);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(valid), "utf8"), cipher.final()]);
    await this.records.set(userId, JSON.stringify({
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url")
    }));
  }

  delete(userId: UserId): Promise<void> {
    return this.records.delete(userId);
  }
}

export interface PkceAuthorizationRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state?: string;
  readonly baseUrl?: string;
}

export interface PkceAuthorization {
  readonly authorizationUrl: string;
  readonly codeVerifier: string;
  readonly state: string;
}

export function createPkceAuthorization(request: PkceAuthorizationRequest): PkceAuthorization {
  const codeVerifier = randomBytes(32).toString("base64url");
  const state = request.state ?? randomBytes(24).toString("base64url");
  const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const url = new URL("/oauth", request.baseUrl ?? DEFAULT_BASE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: request.scopes.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
    state
  }).toString();
  return { authorizationUrl: url.toString(), codeVerifier, state };
}

export async function exchangeLichessAuthorizationCode(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}): Promise<{ readonly accessToken: string }> {
  const response = await (input.fetch ?? fetch)(new URL("/api/token", input.baseUrl ?? DEFAULT_BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: input.clientId
    })
  });
  if (!response.ok) throw new PlatformError("FORBIDDEN", "Lichess authorization code exchange failed");
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.access_token !== "string") {
    throw new PlatformError("INVALID_STATE", "Lichess returned an invalid token response");
  }
  return { accessToken: body.access_token };
}

export interface LichessPlatformOptions {
  readonly credentials: LichessCredentialStore;
  readonly userId: UserId;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxRateLimitRetries?: number;
}

/** Lichess Board/API adapter. One instance is scoped to one authenticated user. */
export class LichessPlatform implements ChessPlatform {
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #maxRateLimitRetries: number;
  #requestTail: Promise<void> = Promise.resolve();
  readonly #createdGames = new Map<string, Promise<GameId>>();

  constructor(private readonly options: LichessPlatformOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#maxRateLimitRetries = options.maxRateLimitRetries ?? 1;
  }

  async createGame(options: CreateGameOptions, idempotencyKey: string): Promise<VersionedGame> {
    if (options.mode !== "computer") {
      throw new PlatformError("INVALID_STATE", "Lichess human games require a challenge or seek workflow");
    }
    let pending = this.#createdGames.get(idempotencyKey);
    if (pending === undefined) {
      pending = this.#createComputerGame(options);
      this.#createdGames.set(idempotencyKey, pending);
      pending.catch(() => this.#createdGames.delete(idempotencyKey));
    }
    const id = await pending;
    return this.getGame(id);
  }

  async #createComputerGame(options: CreateGameOptions): Promise<GameId> {
    const form = new URLSearchParams({
      level: String(options.computerLevel ?? 3),
      "clock.limit": String(Math.floor((options.initialMs ?? 300_000) / 1_000)),
      "clock.increment": String(Math.floor((options.incrementMs ?? 0) / 1_000)),
      color: options.color,
      variant: "standard"
    });
    const response = await this.#request("/api/challenge/ai", { method: "POST", body: form });
    return extractGameId(await response.json());
  }

  async getGame(gameId: GameId): Promise<VersionedGame> {
    const response = await this.#request(`/game/export/${encodeURIComponent(gameId)}`, {
      headers: { accept: "application/json" }
    });
    return this.#mapGame(await response.json());
  }

  async listRecentGames(_userId: UserId, page: PageRequest): Promise<Page<VersionedGame>> {
    const credential = await this.#credential();
    const offset = page.cursor === undefined ? 0 : Number.parseInt(page.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new PlatformError("INVALID_STATE", "invalid cursor");
    const url = new URL(`/api/games/user/${encodeURIComponent(credential.username)}`, this.#baseUrl);
    url.search = new URLSearchParams({
      max: String(page.limit + offset + 1),
      moves: "true",
      clocks: "true",
      evals: "false",
      opening: "false"
    }).toString();
    const response = await this.#request(url, { headers: { accept: "application/x-ndjson" } });
    const games = parseNdjson(await response.text()).map((value) => this.#mapGameValue(value, credential.username));
    const items = games.slice(offset, offset + page.limit);
    return offset + items.length < games.length
      ? { items, nextCursor: String(offset + items.length) }
      : { items };
  }

  async makeMove(gameId: GameId, move: string, expectedRevision: number): Promise<VersionedGame> {
    const current = await this.getGame(gameId);
    assertRevision(current, expectedRevision);
    await this.#request(`/api/board/game/${encodeURIComponent(gameId)}/move/${encodeURIComponent(move)}`, { method: "POST" });
    return this.getGame(gameId);
  }

  async resign(gameId: GameId, _userId: UserId, expectedRevision: number): Promise<VersionedGame> {
    const current = await this.getGame(gameId);
    assertRevision(current, expectedRevision);
    await this.#request(`/api/board/game/${encodeURIComponent(gameId)}/resign`, { method: "POST" });
    return this.getGame(gameId);
  }

  async exportPgn(gameId: GameId): Promise<Pgn> {
    const response = await this.#request(`/game/export/${encodeURIComponent(gameId)}`, {
      headers: { accept: "application/x-chess-pgn" }
    });
    return await response.text() as Pgn;
  }

  async #mapGame(value: unknown): Promise<VersionedGame> {
    const credential = await this.#credential();
    return this.#mapGameValue(value, credential.username);
  }

  #mapGameValue(value: unknown, localUsername: string): VersionedGame {
    if (!isRecord(value) || typeof value.id !== "string") throw providerDataError("game id");
    const moves = typeof value.moves === "string" ? value.moves.trim().split(/\s+/).filter(Boolean) : [];
    const initialFen = typeof value.initialFen === "string" && value.initialFen !== "startpos" ? value.initialFen : undefined;
    const rules = new ChessRules(initialFen);
    const played = moves.map((move) => rules.makeMove(move));
    const players = isRecord(value.players) ? value.players : {};
    const whiteName = playerName(players.white);
    const blackName = playerName(players.black);
    const statusName = typeof value.status === "string" ? value.status : "started";
    const winner = value.winner === "white" || value.winner === "black" ? value.winner : undefined;
    const game: ChessGame = {
      id: value.id as GameId,
      provider: "lichess",
      mode: playerIsAi(players.white) || playerIsAi(players.black) ? "computer" : "human",
      ...(sameUsername(whiteName, localUsername) ? { whiteUserId: this.options.userId } : {}),
      ...(sameUsername(blackName, localUsername) ? { blackUserId: this.options.userId } : {}),
      status: mapStatus(statusName),
      result: mapResult(winner, statusName),
      currentFen: rules.state().fen,
      moves: played
    };
    return { game, revision: played.length };
  }

  async #request(path: string | URL, init: RequestInit = {}): Promise<Response> {
    return this.#serialize(async () => {
      const credential = await this.#credential();
      for (let attempt = 0; ; attempt += 1) {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${credential.accessToken}`);
        const response = await this.#fetch(path instanceof URL ? path : new URL(path, this.#baseUrl), { ...init, headers });
        if (response.status !== 429 || attempt >= this.#maxRateLimitRetries) {
          if (!response.ok) throw mapHttpError(response.status);
          return response;
        }
        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "60", 10);
        await this.#sleep((Number.isFinite(retryAfter) ? retryAfter : 60) * 1_000);
      }
    });
  }

  async #credential(): Promise<LichessCredential> {
    const credential = await this.options.credentials.get(this.options.userId);
    if (credential === undefined) throw new PlatformError("FORBIDDEN", "Lichess account is not connected");
    return credential;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#requestTail.then(operation, operation);
    this.#requestTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateCredential(value: unknown): LichessCredential {
  if (!isRecord(value) || typeof value.username !== "string" || value.username.length === 0 ||
      typeof value.accessToken !== "string" || value.accessToken.length === 0) {
    throw new TypeError("invalid Lichess credential");
  }
  return { username: value.username, accessToken: value.accessToken };
}

function parseNdjson(text: string): unknown[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as unknown);
}

function extractGameId(value: unknown): GameId {
  if (!isRecord(value)) throw providerDataError("created game");
  const id = typeof value.id === "string" ? value.id
    : isRecord(value.game) && typeof value.game.id === "string" ? value.game.id
      : undefined;
  if (id === undefined) throw providerDataError("created game id");
  return id as GameId;
}

function playerName(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.user)) return undefined;
  return typeof value.user.name === "string" ? value.user.name
    : typeof value.user.id === "string" ? value.user.id
      : undefined;
}

function playerIsAi(value: unknown): boolean {
  return isRecord(value) && typeof value.aiLevel === "number";
}

function sameUsername(value: string | undefined, expected: string): boolean {
  return value?.toLocaleLowerCase("en-US") === expected.toLocaleLowerCase("en-US");
}

function mapStatus(status: string): GameStatus {
  if (["created", "started"].includes(status)) return status as "created" | "started";
  if (status === "mate") return "checkmate";
  if (status === "stalemate") return "stalemate";
  if (status === "resign") return "resigned";
  if (status === "aborted") return "aborted";
  if (["draw", "repetition", "insufficient", "fiftymoves"].includes(status)) return "draw";
  return "finished";
}

function mapResult(winner: Color | undefined, status: string): GameResult {
  if (winner === "white") return "1-0";
  if (winner === "black") return "0-1";
  return ["created", "started"].includes(status) ? "*" : "1/2-1/2";
}

function assertRevision(game: VersionedGame, expected: number): void {
  if (game.revision !== expected) throw new PlatformError("CONFLICT", "game changed; reload before retrying", true);
}

function mapHttpError(status: number): PlatformError {
  if (status === 401 || status === 403) return new PlatformError("FORBIDDEN", "Lichess rejected authorization");
  if (status === 404) return new PlatformError("NOT_FOUND", "Lichess game was not found");
  if (status === 409) return new PlatformError("CONFLICT", "Lichess game state changed", true);
  if (status === 400 || status === 422) return new PlatformError("ILLEGAL_MOVE", "Lichess rejected the operation");
  return new PlatformError("INVALID_STATE", `Lichess request failed with status ${status}`, status >= 500 || status === 429);
}

function providerDataError(field: string): PlatformError {
  return new PlatformError("INVALID_STATE", `Lichess returned invalid ${field}`, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
