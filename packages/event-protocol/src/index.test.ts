import { describe, expect, it } from "vitest";
import { assertPlatformEvent, shouldApplyEvent } from "./index.js";
import type { PlatformEvent } from "./index.js";

const event = {
  version: 1,
  id: "event_1",
  sessionId: "session_1",
  sequence: 2,
  occurredAt: "2026-07-01T00:00:00.000Z",
  type: "agent.message.delta",
  payload: { text: "Hello" }
} as unknown as PlatformEvent;

describe("event protocol", () => {
  it("validates envelopes and supports deduplication", () => {
    expect(() => assertPlatformEvent(event)).not.toThrow();
    expect(shouldApplyEvent(1, event)).toBe(true);
    expect(shouldApplyEvent(2, event)).toBe(false);
  });

  it("rejects unknown event types", () => {
    expect(() => assertPlatformEvent({ ...event, type: "unknown" })).toThrow(TypeError);
  });
});

