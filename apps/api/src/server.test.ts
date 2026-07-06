import { describe, expect, it } from "vitest";
import { readServerConfig } from "./server.js";

describe("server configuration", () => {
  it("validates required secrets and parses the runtime configuration", () => {
    const config = readServerConfig({
      APP_TOKEN: "app",
      APP_USER_ID: "user_1",
      LICHESS_CLIENT_ID: "client",
      LICHESS_REDIRECT_URI: "http://localhost:3000/v1/oauth/lichess/callback",
      CREDENTIAL_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
      STOCKFISH_PATH: "/usr/bin/stockfish",
      PORT: "3001"
    });
    expect(config).toMatchObject({ port: 3001, modelProvider: "ollama", modelName: "qwen3:4b" });
    expect(() => readServerConfig({
      MODEL_PROVIDER: "openai",
      APP_TOKEN: "app",
      APP_USER_ID: "user_1",
      LICHESS_CLIENT_ID: "client",
      LICHESS_REDIRECT_URI: "http://localhost/callback",
      CREDENTIAL_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
      STOCKFISH_PATH: "/usr/bin/stockfish"
    })).toThrow("OPENAI_API_KEY");
    expect(() => readServerConfig({})).toThrow("CREDENTIAL_ENCRYPTION_KEY_BASE64");
  });
});
