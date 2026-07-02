import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export interface CliOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

export async function runCli(options: CliOptions = {}): Promise<void> {
  const baseUrl = options.baseUrl ?? process.env.CHESS_AGENT_API_URL ?? "http://localhost:3000";
  const token = options.token ?? process.env.CHESS_AGENT_TOKEN;
  const output = options.output ?? stdout;
  if (!token) throw new Error("Set CHESS_AGENT_TOKEN before starting the CLI");
  const prompt = createInterface({ input: options.input ?? stdin, output, terminal: true });
  let sessionId: string | undefined;
  output.write("Chess Agent CLI — type /quit to leave\n");
  try {
    for (;;) {
      const message = (await prompt.question("you> ")).trim();
      if (message === "/quit" || message === "/exit") return;
      if (!message) continue;
      const response = await fetch(`${baseUrl}/v1/agent/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ message, ...(sessionId === undefined ? {} : { sessionId }) })
      });
      if (!response.ok) {
        output.write(`error> ${await errorMessage(response)}\n`);
        continue;
      }
      const body = await response.json() as { sessionId: string; result: { message: string } };
      sessionId = body.sessionId;
      output.write(`agent> ${body.result.message}\n`);
      const snapshot = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events/snapshot`, {
        headers: { authorization: `Bearer ${token}` }
      });
      if (snapshot.ok) {
        const value = await snapshot.json() as { events: Array<{ type: string; payload: { fen?: string } }> };
        const fen = value.events.filter(({ type }) => type === "board.position_changed").at(-1)?.payload.fen;
        if (fen !== undefined) output.write(`${renderFen(fen)}\n`);
      }
    }
  } finally {
    prompt.close();
  }
}

export function renderFen(fen: string): string {
  const pieces: Record<string, string> = {
    K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙",
    k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟"
  };
  const ranks = fen.split(" ")[0]?.split("/") ?? [];
  if (ranks.length !== 8) throw new TypeError("Invalid FEN");
  const rows = ranks.map((rank, index) => {
    const squares: string[] = [];
    for (const token of rank) {
      if (/\d/.test(token)) squares.push(...Array.from({ length: Number(token) }, () => "·"));
      else squares.push(pieces[token] ?? "?");
    }
    if (squares.length !== 8) throw new TypeError("Invalid FEN rank");
    return `${8 - index}  ${squares.join(" ")}`;
  });
  return `${rows.join("\n")}\n\n   a b c d e f g h`;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

