import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@chess-agent/agent-runtime";
import type { AgentSession } from "@chess-agent/agent-tools";
import type { EncryptedRecordStore } from "@chess-agent/platform-adapter";
import type { Job, SessionId, UserId } from "@chess-agent/shared-types";
import type { PuzzleProgressRepository, PuzzleProgressState } from "@chess-agent/puzzle";
import type { PlatformEvent } from "@chess-agent/event-protocol";
import type { AuditRecord, AuditSink } from "@chess-agent/agent-tools";
import type { EngineAnalysis, EngineAnalysisCache } from "@chess-agent/engine";
import type { ReviewArtifact, ReviewArtifactRepository } from "@chess-agent/review";

export interface StoredAgentState {
  readonly session: AgentSession;
  readonly history: readonly AgentMessage[];
}

export interface AgentStateRepository {
  load(userId: UserId, sessionId: SessionId): Promise<StoredAgentState | undefined>;
  save(userId: UserId, state: StoredAgentState): Promise<void>;
}

interface StateFile {
  readonly version: 1;
  readonly encryptedRecords: Record<string, string>;
  readonly agentStates: Record<string, StoredAgentState>;
  readonly puzzleProgress?: PuzzleProgressState;
  readonly sessionEvents?: Record<string, readonly PlatformEvent[]>;
  readonly auditRecords?: readonly AuditRecord[];
  readonly engineCache?: Record<string, EngineAnalysis>;
  readonly reviews?: Record<string, ReviewArtifact>;
  readonly reviewJobs?: Record<string, { readonly owner: UserId; readonly job: Job<ReviewArtifact> }>;
}

const EMPTY_STATE: StateFile = { version: 1, encryptedRecords: {}, agentStates: {} };

/** Atomic, permission-restricted local persistence for the single-node MVP. */
export class FileStateStore implements EncryptedRecordStore, AgentStateRepository, PuzzleProgressRepository, AuditSink, EngineAnalysisCache, ReviewArtifactRepository {
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(key: string): Promise<string | undefined> {
    return (await this.#read()).encryptedRecords[key];
  }

  async set(key: string, value: string): Promise<void> {
    await this.#mutate((state) => ({
      ...state,
      encryptedRecords: { ...state.encryptedRecords, [key]: value }
    }));
  }

  async delete(key: string): Promise<void> {
    await this.#mutate((state) => {
      const encryptedRecords = { ...state.encryptedRecords };
      delete encryptedRecords[key];
      return { ...state, encryptedRecords };
    });
  }

  async load(userId: UserId, sessionId: SessionId): Promise<StoredAgentState | undefined> {
    return (await this.#read()).agentStates[stateKey(userId, sessionId)];
  }

  async save(userId: UserId, value: StoredAgentState): Promise<void> {
    await this.#mutate((state) => ({
      ...state,
      agentStates: { ...state.agentStates, [stateKey(userId, value.session.id)]: value }
    }));
  }

  async loadPuzzleProgress(): Promise<PuzzleProgressState | undefined> {
    return (await this.#read()).puzzleProgress;
  }

  async savePuzzleProgress(value: PuzzleProgressState): Promise<void> {
    await this.#mutate((state) => ({ ...state, puzzleProgress: value }));
  }

  async loadSessionEvents(): Promise<Record<string, readonly PlatformEvent[]>> {
    return (await this.#read()).sessionEvents ?? {};
  }

  async saveEvent(event: PlatformEvent): Promise<void> {
    await this.#mutate((state) => ({
      ...state,
      sessionEvents: {
        ...(state.sessionEvents ?? {}),
        [event.sessionId]: [...(state.sessionEvents?.[event.sessionId] ?? []), event].slice(-1_000)
      }
    }));
  }

  async write(record: AuditRecord): Promise<void> {
    await this.#mutate((state) => ({ ...state, auditRecords: [...(state.auditRecords ?? []), record].slice(-10_000) }));
  }

  async getAnalysis(key: string): Promise<EngineAnalysis | undefined> {
    return (await this.#read()).engineCache?.[key];
  }

  async setAnalysis(key: string, value: EngineAnalysis): Promise<void> {
    await this.#mutate((state) => ({ ...state, engineCache: { ...(state.engineCache ?? {}), [key]: value } }));
  }

  async getReview(id: string): Promise<ReviewArtifact | undefined> {
    return (await this.#read()).reviews?.[id];
  }

  async saveReview(value: ReviewArtifact): Promise<void> {
    await this.#mutate((state) => ({ ...state, reviews: { ...(state.reviews ?? {}), [value.id]: value } }));
  }

  async getReviewJob(id: string): Promise<{ readonly owner: UserId; readonly job: Job<ReviewArtifact> } | undefined> {
    return (await this.#read()).reviewJobs?.[id];
  }

  async saveReviewJob(id: string, owner: UserId, job: Job<ReviewArtifact>): Promise<void> {
    await this.#mutate((state) => ({ ...state, reviewJobs: { ...(state.reviewJobs ?? {}), [id]: { owner, job } } }));
  }

  async #mutate(update: (state: StateFile) => StateFile): Promise<void> {
    const operation = this.#tail.then(async () => {
      const next = update(await this.#read());
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    await operation;
  }

  async #read(): Promise<StateFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isStateFile(value)) throw new Error("State file has an unsupported format");
      return value;
    } catch (error) {
      if (isMissingFile(error)) return EMPTY_STATE;
      throw error;
    }
  }
}

function stateKey(userId: UserId, sessionId: SessionId): string {
  return `${userId}:${sessionId}`;
}

function isStateFile(value: unknown): value is StateFile {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>).version === 1 &&
    typeof (value as Record<string, unknown>).encryptedRecords === "object" &&
    typeof (value as Record<string, unknown>).agentStates === "object";
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
