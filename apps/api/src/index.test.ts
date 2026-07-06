import { describe, expect, it } from "vitest";
import type { AgentRunResult } from "@chess-agent/agent-runtime";
import type { UserId } from "@chess-agent/shared-types";
import { createApi } from "./index.js";

const result: AgentRunResult = {
  message: "Your game is ready.",
  actions: [{ type: "open_game", resourceId: "game_1" }],
  steps: 1,
  usage: { inputTokens: 1, outputTokens: 1 },
  messages: []
};

describe("API", () => {
  it("reports health and requires authentication", async () => {
    const app = createApi({
      authenticate: { authenticate: async () => undefined },
      agent: { run: async () => result }
    });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const response = await app.inject({ method: "POST", url: "/v1/agent/runs", payload: { message: "hello" } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("creates a secure local browser session and reports connection status", async () => {
    const userId = "user_1" as UserId;
    const app = createApi({
      authenticate: { authenticate: async (header) => header === "Bearer local-secret" ? userId : undefined },
      agent: { run: async () => result },
      localSessionToken: "local-secret",
      connectionStatus: async () => ({ lichessConnected: true, username: "Alice" })
    });
    const login = await app.inject({ method: "POST", url: "/v1/local/session" });
    expect(login.headers["set-cookie"]).toContain("HttpOnly");
    expect(login.headers["set-cookie"]).toContain("SameSite=Strict");
    const status = await app.inject({ method: "GET", url: "/v1/connection", headers: { cookie: "chess_agent_session=local-secret" } });
    expect(status.json()).toEqual({ lichessConnected: true, username: "Alice" });
    await app.close();
  });

  it("runs the agent and records replayable session events", async () => {
    const userId = "user_1" as UserId;
    const app = createApi({
      authenticate: { authenticate: async (header) => header === "Bearer app-token" ? userId : undefined },
      agent: { run: async () => result }
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/agent/runs",
      headers: { authorization: "Bearer app-token" },
      payload: { sessionId: "session_1", message: "Start a game" }
    });
    expect(response.statusCode).toBe(200);
    const snapshot = await app.inject({
      method: "GET",
      url: "/v1/sessions/session_1/events/snapshot?after=0",
      headers: { authorization: "Bearer app-token" }
    });
    expect(snapshot.json().events.map((event: { type: string }) => event.type)).toEqual([
      "agent.message.delta",
      "agent.message.completed",
      "ui.open_panel"
    ]);
    await app.close();
  });

  it("enforces session ownership and per-user rate limits", async () => {
    const app = createApi({
      authenticate: { authenticate: async (header) => header?.endsWith("a") ? "user_a" as UserId : "user_b" as UserId },
      agent: { run: async () => result },
      rateLimitPerMinute: 1
    });
    const first = await app.inject({ method: "POST", url: "/v1/agent/runs", headers: { authorization: "a" }, payload: { sessionId: "private", message: "hello" } });
    expect(first.statusCode).toBe(200);
    const limited = await app.inject({ method: "POST", url: "/v1/agent/runs", headers: { authorization: "a" }, payload: { message: "again" } });
    expect(limited.statusCode).toBe(429);
    const other = await app.inject({ method: "GET", url: "/v1/sessions/private/events/snapshot", headers: { authorization: "b" } });
    expect(other.statusCode).toBe(404);
    await app.close();
  });

  it("publishes completed review artifacts for the learning UI", async () => {
    const reviewResult: AgentRunResult = {
      ...result,
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "get_review", arguments: { reviewId: "job_1" } }] },
        {
          role: "tool",
          toolCallId: "call_1",
          name: "get_review",
          content: JSON.stringify({
            ok: true,
            value: {
              id: "job_1",
              status: "succeeded",
              result: {
                id: "review_1",
                gameId: "game_1",
                criticalMoments: [{
                  ply: 12,
                  fenBefore: "8/8/8/8/8/8/8/K6k w - - 0 1",
                  playedMove: "a1a2",
                  bestMove: "a1b1",
                  lossCentipawns: 140,
                  classification: "mistake",
                  themes: ["king safety"],
                  bestLine: ["a1b1"]
                }]
              }
            }
          })
        }
      ]
    };
    const app = createApi({
      authenticate: { authenticate: async () => "user_1" as UserId },
      agent: { run: async () => reviewResult }
    });
    await app.inject({ method: "POST", url: "/v1/agent/runs", headers: { authorization: "token" }, payload: { sessionId: "review", message: "Review it" } });
    const snapshot = await app.inject({ method: "GET", url: "/v1/sessions/review/events/snapshot", headers: { authorization: "token" } });
    const completed = snapshot.json().events.find((event: { type: string }) => event.type === "review.completed");
    expect(completed.payload).toMatchObject({ reviewId: "review_1", gameId: "game_1" });
    expect(completed.payload.criticalMoments[0]).toMatchObject({ ply: 12, classification: "mistake" });
    await app.close();
  });

  it("starts live synchronization for active games returned by tools", async () => {
    const watched: string[] = [];
    let closed = false;
    const gameResult: AgentRunResult = {
      ...result,
      messages: [{
        role: "tool",
        toolCallId: "call_game",
        name: "get_game",
        content: JSON.stringify({ ok: true, value: { game: { id: "game_live", status: "started", currentFen: "8/8/8/8/8/8/8/K6k w - - 0 1", moves: [] } } })
      }]
    };
    const app = createApi({
      authenticate: { authenticate: async () => "user_1" as UserId },
      agent: { run: async () => gameResult },
      gameSync: {
        watch: (_userId, _sessionId, gameId) => watched.push(gameId),
        close: async () => { closed = true; }
      }
    });
    await app.inject({ method: "POST", url: "/v1/agent/runs", headers: { authorization: "token" }, payload: { message: "show game" } });
    expect(watched).toEqual(["game_live"]);
    await app.close();
    expect(closed).toBe(true);
  });

  it("starts automatic progress monitoring for review jobs", async () => {
    const watched: string[] = [];
    const reviewStarted: AgentRunResult = {
      ...result,
      messages: [{
        role: "tool",
        toolCallId: "review_call",
        name: "review_game",
        content: JSON.stringify({ ok: true, value: { jobId: "review_job_1" } })
      }]
    };
    const app = createApi({
      authenticate: { authenticate: async () => "user_1" as UserId },
      agent: {
        run: async () => reviewStarted,
        watchReview: (_userId, _sessionId, jobId) => watched.push(jobId)
      }
    });
    await app.inject({ method: "POST", url: "/v1/agent/runs", headers: { authorization: "token" }, payload: { message: "review" } });
    expect(watched).toEqual(["review_job_1"]);
    await app.close();
  });
});
