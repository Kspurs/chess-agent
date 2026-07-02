import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { PlatformEvent } from "@chess-agent/event-protocol";
import { fenToBoard, runAgent, subscribeEvents } from "./index.js";
import "./styles.css";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const PIECES: Record<string, string> = {
  K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙",
  k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟"
};

interface ChatMessage { readonly role: "user" | "agent"; readonly text: string }

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem("chess-agent-token") ?? "");
  const [sessionId, setSessionId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "agent", text: "Ready when you are. Start a game, review one, or ask for a puzzle." }
  ]);
  const [fen, setFen] = useState(START_FEN);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const board = useMemo(() => fenToBoard(fen), [fen]);

  useEffect(() => {
    if (sessionId === undefined || token.length === 0) return;
    const controller = new AbortController();
    void subscribeEvents(sessionId, token, (event: PlatformEvent) => {
      if (event.type === "board.position_changed") setFen(event.payload.fen);
      if (event.type === "puzzle.started") setFen(event.payload.fen);
      if (event.type === "puzzle.feedback") setMessages((current) => [...current, { role: "agent", text: event.payload.message }]);
    }, controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Event stream disconnected");
    });
    return () => controller.abort();
  }, [sessionId, token]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const message = input.trim();
    if (!message || !token.trim() || busy) return;
    setInput("");
    setError(undefined);
    setMessages((current) => [...current, { role: "user", text: message }]);
    setBusy(true);
    try {
      localStorage.setItem("chess-agent-token", token.trim());
      const response = await runAgent(message, token.trim(), sessionId);
      setSessionId(response.sessionId);
      setMessages((current) => [...current, { role: "agent", text: response.result.message }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function connectLichess(): Promise<void> {
    setError(undefined);
    try {
      const response = await fetch("/v1/oauth/lichess/start", { headers: { authorization: `Bearer ${token.trim()}` } });
      if (!response.ok) throw new Error("Could not start Lichess connection");
      const body = await response.json() as { authorizationUrl: string };
      window.location.assign(body.authorizationUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not connect Lichess");
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div><span className="mark">♞</span><strong>Chess Agent</strong></div>
        <div className="account"><button onClick={() => void connectLichess()} disabled={!token.trim()}>Connect Lichess</button><label className="token">Access token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="App token" /></label></div>
      </header>
      <section className="workspace">
        <div className="board-panel">
          <div className="board" aria-label="Chess board">
            {board.flatMap((rank, row) => rank.map((piece, column) => (
              <div key={`${row}-${column}`} className={`square ${(row + column) % 2 === 0 ? "light" : "dark"}`}>
                <span>{PIECES[piece] ?? ""}</span>
              </div>
            )))}
          </div>
          <div className="position-meta"><span>Current position</span><code>{fen}</code></div>
        </div>
        <div className="chat-panel">
          <div className="messages" aria-live="polite">
            {messages.map((message, index) => <div key={index} className={`message ${message.role}`}>{message.text}</div>)}
            {busy && <div className="message agent thinking">Thinking…</div>}
          </div>
          {error && <div className="error">{error}</div>}
          <form onSubmit={(event) => void submit(event)}>
            <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Start a game, review my last game…" aria-label="Message" />
            <button disabled={busy || !input.trim() || !token.trim()}>Send</button>
          </form>
        </div>
      </section>
    </main>
  );
}
