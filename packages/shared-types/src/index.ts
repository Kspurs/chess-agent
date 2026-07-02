export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type UserId = Brand<string, "UserId">;
export type SessionId = Brand<string, "SessionId">;
export type ConversationId = Brand<string, "ConversationId">;
export type GameId = Brand<string, "GameId">;
export type ReviewId = Brand<string, "ReviewId">;
export type PuzzleId = Brand<string, "PuzzleId">;
export type JobId = Brand<string, "JobId">;
export type EventId = Brand<string, "EventId">;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function parseId<T extends string>(value: unknown, name: string): Brand<string, T> {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(`${name} must be 1-128 URL-safe characters`);
  }
  return value as Brand<string, T>;
}

export interface PageRequest {
  readonly cursor?: string;
  readonly limit: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job<T> {
  readonly id: JobId;
  readonly status: JobStatus;
  readonly progress: number;
  readonly result?: T;
  readonly error?: ApiError;
}

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "INTERNAL";

export interface ApiError {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface UserPreferences {
  readonly notation: "san" | "uci";
  readonly explanationDetail: "brief" | "standard" | "deep";
  readonly boardOrientation: "white" | "black" | "auto";
  readonly locale: string;
}

export function normalizePageRequest(input: Partial<PageRequest> = {}): PageRequest {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("page limit must be an integer from 1 to 100");
  }
  return input.cursor === undefined ? { limit } : { cursor: input.cursor, limit };
}

export function isJobStatus(value: unknown): value is JobStatus {
  return ["queued", "running", "succeeded", "failed", "cancelled"].includes(String(value));
}

