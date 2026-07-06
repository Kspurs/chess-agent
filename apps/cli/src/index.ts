import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export interface CliOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly fetch?: typeof fetch;
}

interface ApiEvent {
  readonly sequence: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export class ChessAgentClient {
  #cookie: string | undefined;
  #sessionId: string | undefined;
  #lastSequence = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly request: typeof fetch = fetch
  ) {}

  get sessionId(): string | undefined { return this.#sessionId; }

  async connect(): Promise<{ readonly lichessConnected: boolean; readonly username?: string }> {
    if (this.token === undefined) {
      const login = await this.request(`${this.baseUrl}/v1/local/session`, { method: "POST" });
      if (!login.ok) throw new Error(`Could not create local session: ${await errorMessage(login)}`);
      this.#cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    }
    const response = await this.request(`${this.baseUrl}/v1/connection`, { headers: this.#headers() });
    if (!response.ok) throw new Error(`Could not connect to API: ${await errorMessage(response)}`);
    return await response.json() as { lichessConnected: boolean; username?: string };
  }

  async chat(message: string): Promise<{ readonly message: string; readonly events: readonly ApiEvent[] }> {
    const response = await this.request(`${this.baseUrl}/v1/agent/runs`, {
      method: "POST",
      headers: { ...this.#headers(), "content-type": "application/json" },
      body: JSON.stringify({ message, ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }) })
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    const body = await response.json() as { sessionId: string; result: { message: string } };
    this.#sessionId = body.sessionId;
    return { message: body.result.message, events: await this.events() };
  }

  async events(): Promise<readonly ApiEvent[]> {
    if (this.#sessionId === undefined) return [];
    const response = await this.request(`${this.baseUrl}/v1/sessions/${encodeURIComponent(this.#sessionId)}/events/snapshot?after=${this.#lastSequence}`, {
      headers: this.#headers()
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    const body = await response.json() as { events: ApiEvent[] };
    this.#lastSequence = body.events.at(-1)?.sequence ?? this.#lastSequence;
    return body.events;
  }

  newSession(): void {
    this.#sessionId = undefined;
    this.#lastSequence = 0;
  }

  #headers(): Record<string, string> {
    if (this.token !== undefined) return { authorization: `Bearer ${this.token}` };
    return this.#cookie === undefined ? {} : { cookie: this.#cookie };
  }
}

export async function runCli(options: CliOptions = {}): Promise<void> {
  const baseUrl = (options.baseUrl ?? process.env.CHESS_AGENT_API_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const output = options.output ?? stdout;
  const client = new ChessAgentClient(baseUrl, options.token ?? process.env.CHESS_AGENT_TOKEN, options.fetch);
  const connection = await client.connect();
  const prompt = createInterface({ input: options.input ?? stdin, output, terminal: Boolean((output as { isTTY?: boolean }).isTTY) });
  output.write(`Chess Agent CLI — ${connection.lichessConnected ? `Lichess: ${connection.username ?? "connected"}` : "Lichess not connected"}\n`);
  output.write("Type /help for commands.\n");
  try {
    for (;;) {
      const message = (await prompt.question("you> ")).trim();
      if (message === "/quit" || message === "/exit") return;
      if (message === "/help") { output.write(helpText); continue; }
      if (message === "/new") { client.newSession(); output.write("system> New conversation started.\n"); continue; }
      if (message === "/status") { output.write(`system> API ${baseUrl}; session ${client.sessionId ?? "not started"}\n`); continue; }
      if (!message) continue;
      try {
        const response = await client.chat(message);
        output.write(`agent> ${response.message}\n`);
        renderEvents(response.events, output);
      } catch (error) {
        output.write(`error> ${error instanceof Error ? error.message : "Request failed"}\n`);
      }
    }
  } finally {
    prompt.close();
  }
}

const helpText = `Commands:\n  /help    Show this help\n  /new     Start a new conversation\n  /status  Show API and session status\n  /quit    Exit\n`;

export function renderEvents(events: readonly ApiEvent[], output: NodeJS.WritableStream): void {
  for (const event of events) {
    if (event.type === "board.position_changed" && typeof event.payload.fen === "string") output.write(`${renderFen(event.payload.fen)}\n`);
    else if (event.type === "game.clock_changed") output.write(`clock> White ${formatClock(event.payload.whiteMs)} · Black ${formatClock(event.payload.blackMs)}\n`);
    else if (event.type === "analysis.progress") output.write(`review> ${String(event.payload.progress)}%\n`);
    else if (event.type === "analysis.completed") output.write("review> Analysis complete.\n");
    else if (event.type === "game.completed") output.write(`game> Finished: ${String(event.payload.result ?? "unknown")}\n`);
    else if (event.type === "puzzle.feedback" && typeof event.payload.message === "string") output.write(`puzzle> ${event.payload.message}\n`);
  }
}

export function renderFen(fen: string): string {
  const pieces: Record<string, string> = { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙", k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
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

function formatClock(value: unknown): string {
  const seconds = Math.max(0, Math.ceil((typeof value === "number" ? value : 0) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${response.status}`;
  } catch { return `HTTP ${response.status}`; }
}
