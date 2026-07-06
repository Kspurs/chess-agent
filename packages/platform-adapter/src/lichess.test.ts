import { describe, expect, it } from "vitest";
import type { UserId } from "@chess-agent/shared-types";
import {
  EncryptedLichessCredentialStore,
  LichessPlatform,
  createPkceAuthorization,
  exchangeLichessAuthorizationCode,
  type EncryptedRecordStore,
  type LichessCredentialStore
} from "./lichess.js";

const userId = "user_1" as UserId;
const credential = { username: "Alice", accessToken: "lip_secret_token" };

class MemoryRecords implements EncryptedRecordStore {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

const credentials: LichessCredentialStore = {
  get: async () => credential,
  set: async () => undefined,
  delete: async () => undefined
};

const game = {
  id: "abc12345",
  status: "started",
  players: {
    white: { user: { id: "alice", name: "Alice" } },
    black: { user: { id: "bob", name: "Bob" } }
  },
  moves: "e2e4 e7e5"
};

describe("Lichess OAuth and credentials", () => {
  it("creates an S256 PKCE authorization request", () => {
    const authorization = createPkceAuthorization({
      clientId: "chess-agent.example",
      redirectUri: "https://example.test/callback",
      scopes: ["board:play"],
      state: "state_1"
    });
    const url = new URL(authorization.authorizationUrl);
    expect(url.pathname).toBe("/oauth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).not.toBe(authorization.codeVerifier);
    expect(authorization.state).toBe("state_1");
  });

  it("exchanges the authorization code with the verifier", async () => {
    let body = "";
    const result = await exchangeLichessAuthorizationCode({
      clientId: "client",
      redirectUri: "https://example.test/callback",
      code: "code_1",
      codeVerifier: "verifier_1",
      fetch: async (_input, init) => {
        body = String(init?.body);
        return Response.json({ access_token: "token_1", token_type: "bearer" });
      }
    });
    expect(result.accessToken).toBe("token_1");
    expect(body).toContain("code_verifier=verifier_1");
  });

  it("encrypts credentials before storage", async () => {
    const records = new MemoryRecords();
    const store = new EncryptedLichessCredentialStore(records, new Uint8Array(32).fill(7));
    await store.set(userId, credential);
    expect(records.values.get(userId)).not.toContain("lip_secret_token");
    await expect(store.get(userId)).resolves.toEqual(credential);
  });
});

describe("LichessPlatform", () => {
  it("maps exported games and attaches only the local player", async () => {
    let authorization = "";
    const platform = new LichessPlatform({
      credentials,
      userId,
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json(game);
      }
    });
    const result = await platform.getGame("abc12345" as never);
    expect(authorization).toBe("Bearer lip_secret_token");
    expect(result).toMatchObject({ revision: 2, game: { provider: "lichess", whiteUserId: userId } });
    expect(result.game.blackUserId).toBeUndefined();
    expect(result.game.moves.map(({ san }) => san)).toEqual(["e4", "e5"]);
  });

  it("parses NDJSON pages and cursors", async () => {
    const second = { ...game, id: "def67890", moves: "d2d4" };
    const platform = new LichessPlatform({
      credentials,
      userId,
      fetch: async () => new Response(`${JSON.stringify(game)}\n${JSON.stringify(second)}\n`, { status: 200 })
    });
    const firstPage = await platform.listRecentGames(userId, { limit: 1 });
    expect(firstPage.items[0]?.game.id).toBe("abc12345");
    expect(firstPage.nextCursor).toBe("1");
    const secondPage = await platform.listRecentGames(userId, { limit: 1, cursor: "1" });
    expect(secondPage.items[0]?.game.id).toBe("def67890");
  });

  it("lists unsupported variants without applying standard chess rules", async () => {
    const racingKings = { ...game, variant: "racingKings", moves: "Kh3 Ka3 Kh4" };
    const platform = new LichessPlatform({
      credentials,
      userId,
      fetch: async () => new Response(`${JSON.stringify(racingKings)}\n`, { status: 200 })
    });
    const page = await platform.listRecentGames(userId, { limit: 1 });
    expect(page.items[0]).toMatchObject({ game: { variant: "racingKings", moves: [] } });
  });

  it("checks revisions before sending moves", async () => {
    const urls: string[] = [];
    const platform = new LichessPlatform({
      credentials,
      userId,
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        return url.includes("/move/") ? Response.json({ ok: true }) : Response.json(game);
      }
    });
    await expect(platform.makeMove("abc12345" as never, "g1f3", 1)).rejects.toMatchObject({ code: "CONFLICT" });
    await platform.makeMove("abc12345" as never, "g1f3", 2);
    expect(urls.some((url) => url.endsWith("/move/g1f3"))).toBe(true);
  });

  it("streams authoritative positions, clocks, and completion", async () => {
    const updates: Array<{ revision: number; status: string; result: string; lastMove?: string; whiteMs?: number }> = [];
    const events = [
      { type: "gameFull", variant: { key: "standard" }, initialFen: "startpos", state: { type: "gameState", moves: "e2e4", wtime: 299_000, btime: 300_000, status: "started" } },
      { type: "gameState", moves: "e2e4 e7e5", wtime: 299_000, btime: 298_000, status: "resign", winner: "white" }
    ];
    const platform = new LichessPlatform({
      credentials,
      userId,
      fetch: async () => new Response(events.map((event) => JSON.stringify(event)).join("\n"), { status: 200 })
    });
    await platform.watchGame("abc12345" as never, (update) => updates.push(update), new AbortController().signal);
    expect(updates).toMatchObject([
      { revision: 1, status: "started", lastMove: "e2e4", whiteMs: 299_000 },
      { revision: 2, status: "resigned", lastMove: "e7e5", whiteMs: 299_000 }
    ]);
    expect(updates[1]?.result).toBe("1-0");
  });

  it("creates computer games idempotently", async () => {
    let creates = 0;
    const platform = new LichessPlatform({
      credentials,
      userId,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/api/challenge/ai")) {
          creates += 1;
          return Response.json({ id: "abc12345" }, { status: 201 });
        }
        return Response.json({ ...game, players: { white: { user: { name: "Alice" } }, black: { aiLevel: 3 } } });
      }
    });
    const options = { requesterUserId: userId, mode: "computer" as const, color: "white" as const };
    await platform.createGame(options, "request_1");
    await platform.createGame(options, "request_1");
    expect(creates).toBe(1);
  });

  it("creates direct human challenges idempotently", async () => {
    let creates = 0;
    let submittedBody = "";
    const platform = new LichessPlatform({
      credentials,
      userId,
      fetch: async (input, init) => {
        expect(String(input)).toContain("/api/challenge/Bob");
        creates += 1;
        submittedBody = String(init?.body);
        return Response.json({ id: "human123", status: "created" });
      }
    });
    const options = {
      requesterUserId: userId,
      mode: "human" as const,
      color: "black" as const,
      opponentUsername: "Bob",
      initialMs: 600_000,
      incrementMs: 5_000,
      rated: true
    };
    const first = await platform.createGame(options, "human-request");
    const repeated = await platform.createGame(options, "human-request");
    expect(first).toMatchObject({ game: { id: "human123", mode: "human", status: "created", blackUserId: userId } });
    expect(repeated.game.id).toBe(first.game.id);
    expect(creates).toBe(1);
    expect(submittedBody).toContain("clock.limit=600");
    expect(submittedBody).toContain("rated=true");
  });

  it("creates correspondence challenges without realtime clock fields", async () => {
    let body = "";
    const platform = new LichessPlatform({
      credentials,
      userId,
      fetch: async (_input, init) => {
        body = String(init?.body);
        return Response.json({ id: "correspondence1", status: "created" });
      }
    });
    await platform.createGame({ requesterUserId: userId, mode: "human", color: "white", opponentUsername: "Bob", daysPerTurn: 3 }, "corr");
    expect(body).toContain("days=3");
    expect(body).not.toContain("clock.limit");
  });

  it("calls draw response, cancellation, and rematch endpoints", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    const platform = new LichessPlatform({
      credentials,
      userId,
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, ...(init?.method === undefined ? {} : { method: init.method }) });
        return url.includes("/game/export/") ? Response.json(game) : Response.json({ ok: true });
      }
    });
    await platform.respondToDraw("abc12345" as never, userId, false, 2);
    await platform.cancelChallenge("pending1" as never, userId);
    await platform.requestRematch("abc12345" as never, userId);
    expect(requests.some(({ url, method }) => url.endsWith("/draw/no") && method === "POST")).toBe(true);
    expect(requests.some(({ url, method }) => url.endsWith("/api/challenge/pending1") && method === "DELETE")).toBe(true);
    expect(requests.some(({ url, method }) => url.endsWith("/rematch") && method === "POST")).toBe(true);
  });

  it("serializes requests and retries rate limits", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const sleeps: number[] = [];
    const platform = new LichessPlatform({
      credentials,
      userId,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      fetch: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls += 1;
        await Promise.resolve();
        active -= 1;
        if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "2" } });
        return Response.json(game);
      }
    });
    await Promise.all([
      platform.getGame("abc12345" as never),
      platform.getGame("abc12345" as never)
    ]);
    expect(maxActive).toBe(1);
    expect(sleeps).toEqual([2_000]);
  });
});
