import type { PlatformEvent } from "@chess-agent/event-protocol";

export interface AgentRunResponse {
  readonly sessionId: string;
  readonly result: {
    readonly message: string;
    readonly actions: readonly { readonly type: string; readonly resourceId?: string }[];
  };
}

export async function runAgent(message: string, sessionId?: string): Promise<AgentRunResponse> {
  const response = await fetch("/v1/agent/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, ...(sessionId === undefined ? {} : { sessionId }) })
  });
  if (!response.ok) throw new Error(await apiError(response));
  return await response.json() as AgentRunResponse;
}

export async function subscribeEvents(
  sessionId: string,
  onEvent: (event: PlatformEvent) => void,
  signal: AbortSignal,
  after = 0
): Promise<void> {
  const response = await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`, {
    headers: { accept: "text/event-stream" },
    signal
  });
  if (!response.ok || response.body === null) throw new Error(await apiError(response));
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (data !== undefined) onEvent(JSON.parse(data) as PlatformEvent);
    }
  }
}

export function fenToBoard(fen: string): string[][] {
  const ranks = fen.split(" ")[0]?.split("/") ?? [];
  if (ranks.length !== 8) throw new TypeError("Invalid FEN");
  return ranks.map((rank) => {
    const squares: string[] = [];
    for (const token of rank) {
      if (/\d/.test(token)) squares.push(...Array.from({ length: Number(token) }, () => ""));
      else squares.push(token);
    }
    if (squares.length !== 8) throw new TypeError("Invalid FEN rank");
    return squares;
  });
}

async function apiError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}
