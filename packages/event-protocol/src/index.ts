import type {
  EventId,
  GameId,
  JobId,
  PuzzleId,
  ReviewId,
  SessionId
} from "@chess-agent/shared-types";

export const EVENT_PROTOCOL_VERSION = 1 as const;

interface EventEnvelope<Type extends string, Payload> {
  readonly version: typeof EVENT_PROTOCOL_VERSION;
  readonly id: EventId;
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: Type;
  readonly payload: Payload;
}

export type PlatformEvent =
  | EventEnvelope<"agent.message.delta", { readonly text: string }>
  | EventEnvelope<"agent.message.completed", { readonly messageId: string }>
  | EventEnvelope<"board.position_changed", { readonly gameId: GameId; readonly fen: string; readonly lastMove?: string }>
  | EventEnvelope<"game.clock_changed", { readonly gameId: GameId; readonly whiteMs: number; readonly blackMs: number; readonly running: "white" | "black" | null }>
  | EventEnvelope<"game.completed", { readonly gameId: GameId; readonly result: string }>
  | EventEnvelope<"analysis.progress", { readonly jobId: JobId; readonly progress: number }>
  | EventEnvelope<"analysis.completed", { readonly jobId: JobId; readonly reviewId: ReviewId }>
  | EventEnvelope<"puzzle.started", { readonly puzzleId: PuzzleId; readonly fen: string; readonly rating: number; readonly themes: readonly string[] }>
  | EventEnvelope<"puzzle.feedback", { readonly puzzleId: PuzzleId; readonly correct: boolean; readonly message: string }>
  | EventEnvelope<"ui.open_panel", { readonly panel: "game" | "review" | "puzzle"; readonly resourceId: string }>;

export interface EventCursor {
  readonly sessionId: SessionId;
  readonly afterSequence: number;
}

export function assertPlatformEvent(value: unknown): asserts value is PlatformEvent {
  if (!isRecord(value)) throw new TypeError("event must be an object");
  if (value.version !== EVENT_PROTOCOL_VERSION) throw new TypeError("unsupported event version");
  if (typeof value.type !== "string" || !isEventType(value.type)) throw new TypeError("unknown event type");
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) throw new TypeError("invalid event sequence");
  if (typeof value.occurredAt !== "string" || Number.isNaN(Date.parse(value.occurredAt))) throw new TypeError("invalid event timestamp");
  if (!isRecord(value.payload)) throw new TypeError("event payload must be an object");
}

export function shouldApplyEvent(lastSequence: number, event: PlatformEvent): boolean {
  return event.sequence > lastSequence;
}

const EVENT_TYPES = new Set<PlatformEvent["type"]>([
  "agent.message.delta",
  "agent.message.completed",
  "board.position_changed",
  "game.clock_changed",
  "game.completed",
  "analysis.progress",
  "analysis.completed",
  "puzzle.started",
  "puzzle.feedback",
  "ui.open_panel"
]);

function isEventType(value: string): value is PlatformEvent["type"] {
  return EVENT_TYPES.has(value as PlatformEvent["type"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
