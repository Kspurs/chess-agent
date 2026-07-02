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
});

