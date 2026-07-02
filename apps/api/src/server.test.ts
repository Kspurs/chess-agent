import { describe, expect, it } from "vitest";
import { readServerConfig } from "./server.js";

describe("server configuration", () => {
  it("validates required secrets and parses the runtime configuration", () => {
    const config = readServerConfig({
      APP_TOKEN: "app",
      APP_USER_ID: "user_1",
      OPENAI_API_KEY: "openai",
      LICHESS_CLIENT_ID: "client",
      LICHESS_REDIRECT_URI: "http://localhost:3000/v1/oauth/lichess/callback",
      CREDENTIAL_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
      STOCKFISH_PATH: "/usr/bin/stockfish",
      PORT: "3001"
    });
    expect(config).toMatchObject({ port: 3001, openAiModel: "gpt-5.4-mini" });
    expect(() => readServerConfig({})).toThrow("CREDENTIAL_ENCRYPTION_KEY_BASE64");
  });
});

