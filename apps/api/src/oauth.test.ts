import { describe, expect, it } from "vitest";
import type { LichessCredential, LichessCredentialStore } from "@chess-agent/platform-adapter";
import type { UserId } from "@chess-agent/shared-types";
import { LichessOAuthCoordinator } from "./oauth.js";

describe("LichessOAuthCoordinator", () => {
  it("binds PKCE state to a user and stores the connected account", async () => {
    const saved = new Map<UserId, LichessCredential>();
    const credentials: LichessCredentialStore = {
      get: async (id) => saved.get(id),
      set: async (id, value) => { saved.set(id, value); },
      delete: async (id) => { saved.delete(id); }
    };
    let calls = 0;
    const oauth = new LichessOAuthCoordinator({
      clientId: "client",
      redirectUri: "https://app.test/callback",
      baseUrl: "https://lichess.test",
      credentials,
      fetch: async () => {
        calls += 1;
        return calls === 1 ? Response.json({ access_token: "token_1" }) : Response.json({ username: "Alice" });
      }
    });
    const authorizationUrl = new URL(oauth.start("user_1" as UserId));
    const state = authorizationUrl.searchParams.get("state") as string;
    await expect(oauth.complete("code_1", state)).resolves.toMatchObject({ userId: "user_1" });
    expect(saved.get("user_1" as UserId)).toEqual({ username: "Alice", accessToken: "token_1" });
    await expect(oauth.complete("code_1", state)).rejects.toThrow("invalid or expired");
  });
});

