import { describe, expect, it } from "vitest";
import { ChessAgentClient, renderFen } from "./index.js";

describe("CLI board renderer", () => {
  it("renders ranks, files, and pieces", () => {
    const output = renderFen("8/8/8/3k4/8/8/4K3/8 w - - 0 1");
    expect(output).toContain("5  · · · ♚");
    expect(output).toContain("2  · · · · ♔");
    expect(output).toContain("a b c d e f g h");
  });
});

describe("ChessAgentClient", () => {
  it("uses local cookie onboarding and keeps a conversation session", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/v1/local/session")) return Response.json({ ready: true }, { headers: { "set-cookie": "chess_agent_session=secret; HttpOnly" } });
      if (url.endsWith("/v1/connection")) return Response.json({ lichessConnected: true, username: "Alice" });
      if (url.endsWith("/v1/agent/runs")) return Response.json({ sessionId: "session_1", result: { message: "Hello" } });
      return Response.json({ events: [{ sequence: 2, type: "board.position_changed", payload: { fen: "8/8/8/8/8/8/8/8 w - - 0 1" } }] });
    };
    const client = new ChessAgentClient("http://localhost:3000", undefined, request as typeof fetch);
    await expect(client.connect()).resolves.toEqual({ lichessConnected: true, username: "Alice" });
    await expect(client.chat("hello")).resolves.toMatchObject({ message: "Hello", events: [{ sequence: 2 }] });
    expect(calls[1]?.init?.headers).toEqual({ cookie: "chess_agent_session=secret" });
    expect(calls[3]?.url).toContain("after=0");
    expect(client.sessionId).toBe("session_1");
    client.newSession();
    expect(client.sessionId).toBeUndefined();
  });

  it("supports explicit bearer authentication", async () => {
    const request = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(init?.headers).toEqual({ authorization: "Bearer app-token" });
      return Response.json({ lichessConnected: false });
    };
    const client = new ChessAgentClient("http://localhost:3000", "app-token", request as typeof fetch);
    await expect(client.connect()).resolves.toEqual({ lichessConnected: false });
  });
});
