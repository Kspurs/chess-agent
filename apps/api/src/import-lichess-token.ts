import { resolve } from "node:path";
import { stdin } from "node:process";
import { EncryptedLichessCredentialStore } from "@chess-agent/platform-adapter";
import type { UserId } from "@chess-agent/shared-types";
import { FileStateStore } from "./file-store.js";

const userId = required("APP_USER_ID") as UserId;
const key = Buffer.from(required("CREDENTIAL_ENCRYPTION_KEY_BASE64"), "base64");
if (key.byteLength !== 32) throw new Error("Credential encryption key must decode to 32 bytes");

process.stderr.write("Paste the Lichess token, then send EOF:\n");
let accessToken = "";
stdin.setEncoding("utf8");
for await (const chunk of stdin) accessToken += chunk;
accessToken = accessToken.trim();
if (!accessToken) throw new Error("No Lichess token was provided");

const response = await fetch("https://lichess.org/api/account", {
  headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
});
if (!response.ok) throw new Error(`Lichess rejected the token (${response.status})`);
const account = await response.json() as { username?: unknown };
if (typeof account.username !== "string") throw new Error("Lichess returned an invalid account profile");

const state = new FileStateStore(resolve(process.env.DATA_DIR ?? "./data", "state.json"));
const credentials = new EncryptedLichessCredentialStore(state, key);
await credentials.set(userId, { username: account.username, accessToken });
process.stdout.write(`Connected Lichess account: ${account.username}\n`);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

