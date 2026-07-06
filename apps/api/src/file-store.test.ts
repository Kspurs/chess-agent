import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionId, UserId } from "@chess-agent/shared-types";
import { FileStateStore } from "./file-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("FileStateStore", () => {
  it("persists encrypted records and agent history across instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chess-agent-state-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const first = new FileStateStore(path);
    await first.set("user_1", "encrypted-envelope");
    await first.save("user_1" as UserId, {
      session: { id: "session_1" as SessionId, mode: "idle" },
      history: [{ role: "user", content: "Review my last game" }]
    });
    await first.savePuzzleProgress({ ratings: { user_1: 1210 }, recent: {}, attempts: [], streaks: { user_1: { current: 2, best: 3 } } });

    const restarted = new FileStateStore(path);
    await expect(restarted.get("user_1")).resolves.toBe("encrypted-envelope");
    await expect(restarted.load("user_1" as UserId, "session_1" as SessionId)).resolves.toMatchObject({
      session: { mode: "idle" },
      history: [{ content: "Review my last game" }]
    });
    await expect(restarted.loadPuzzleProgress()).resolves.toMatchObject({ ratings: { user_1: 1210 }, streaks: { user_1: { current: 2 } } });
  });

  it("serializes concurrent updates without losing keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chess-agent-state-"));
    directories.push(directory);
    const store = new FileStateStore(join(directory, "state.json"));
    await Promise.all([store.set("one", "1"), store.set("two", "2"), store.set("three", "3")]);
    await expect(Promise.all([store.get("one"), store.get("two"), store.get("three")])).resolves.toEqual(["1", "2", "3"]);
  });
});
