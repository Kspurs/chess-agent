import { useEffect, useMemo, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import { ChessRules } from "@chess-agent/chess-domain";
import type { PlatformEvent, ReviewMomentEvent } from "@chess-agent/event-protocol";
import { fenToBoard, runAgent, subscribeEvents } from "./index.js";
import "./styles.css";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const PIECES: Record<string, string> = {
  K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙",
  k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟"
};
const FILES = "abcdefgh";

interface ChatMessage { readonly role: "user" | "agent"; readonly text: string }
interface PuzzleView { readonly id: string; readonly rating: number; readonly themes: readonly string[]; readonly feedback?: string }
interface ReviewView { readonly id: string; readonly moments: readonly ReviewMomentEvent[] }
interface DisplayMove { readonly san: string; readonly uci: string }
interface PendingPromotion { readonly from: string; readonly to: string; readonly moves: ReturnType<ChessRules["legalMoves"]> }

export function App() {
  const [ready, setReady] = useState(false);
  const [connection, setConnection] = useState<{ lichessConnected: boolean; username?: string }>({ lichessConnected: false });
  const [sessionId, setSessionId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "agent", text: "Ready when you are. Start a game, review one, or ask for a puzzle." }
  ]);
  const [fen, setFen] = useState(START_FEN);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [puzzle, setPuzzle] = useState<PuzzleView>();
  const [review, setReview] = useState<ReviewView | undefined>(loadLastReview);
  const [activeGameId, setActiveGameId] = useState<string>();
  const [gameStatus, setGameStatus] = useState<string>();
  const [lastMove, setLastMove] = useState<string>();
  const [selectedSquare, setSelectedSquare] = useState<string>();
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [moveHistory, setMoveHistory] = useState<readonly DisplayMove[]>([]);
  const [clock, setClock] = useState<{ whiteMs: number; blackMs: number; running: "white" | "black" | null }>();
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion>();
  const [analysis, setAnalysis] = useState<{ jobId: string; progress: number; error?: string }>();
  const [selectedMoment, setSelectedMoment] = useState<ReviewMomentEvent>();
  const [variationIndex, setVariationIndex] = useState(0);
  const board = useMemo(() => fenToBoard(fen), [fen]);
  const legalMoves = useMemo(() => {
    try { return new ChessRules(fen).legalMoves(); } catch { return []; }
  }, [fen]);
  const legalTargets = new Set(legalMoves.filter(({ from }) => from === selectedSquare).map(({ to }) => to));
  const displaySquares = useMemo(() => {
    const squares = board.flatMap((rank, row) => rank.map((piece, column) => ({
      piece,
      row,
      column,
      square: `${FILES[column]}${8 - row}`
    })));
    return orientation === "white" ? squares : squares.reverse();
  }, [board, orientation]);

  useEffect(() => {
    void (async () => {
      try {
        const login = await fetch("/v1/local/session", { method: "POST" });
        if (!login.ok) throw new Error("Local setup is unavailable");
        const response = await fetch("/v1/connection");
        if (!response.ok) throw new Error("Could not read connection status");
        setConnection(await response.json() as { lichessConnected: boolean; username?: string });
        setReady(true);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Local setup failed");
      }
    })();
  }, []);

  useEffect(() => {
    if (sessionId === undefined || !ready) return;
    const controller = new AbortController();
    void subscribeEvents(sessionId, (event: PlatformEvent) => {
      if (event.type === "board.position_changed") {
        setFen(event.payload.fen);
        setActiveGameId(event.payload.gameId);
        setLastMove(event.payload.lastMove);
        if (event.payload.moves !== undefined) setMoveHistory(event.payload.moves);
        if (event.payload.orientation !== undefined) setOrientation(event.payload.orientation);
        if (event.payload.status !== undefined) setGameStatus(event.payload.status);
        setSelectedSquare(undefined);
      }
      if (event.type === "game.clock_changed") setClock(event.payload);
      if (event.type === "game.completed") setGameStatus("finished");
      if (event.type === "analysis.progress") setAnalysis({ jobId: event.payload.jobId, progress: event.payload.progress });
      if (event.type === "analysis.failed") setAnalysis({ jobId: event.payload.jobId, progress: 100, error: event.payload.message });
      if (event.type === "analysis.completed") setAnalysis({ jobId: event.payload.jobId, progress: 100 });
      if (event.type === "puzzle.started") {
        setFen(event.payload.fen);
        setPuzzle({ id: event.payload.puzzleId, rating: event.payload.rating, themes: event.payload.themes });
      }
      if (event.type === "puzzle.feedback") {
        setPuzzle((current) => current === undefined ? current : { ...current, feedback: event.payload.message });
        setMessages((current) => [...current, { role: "agent", text: event.payload.message }]);
      }
      if (event.type === "review.completed") {
        setReview({ id: event.payload.reviewId, moments: event.payload.criticalMoments });
        localStorage.setItem("chess-agent-last-review", JSON.stringify(event.payload));
      }
    }, controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Event stream disconnected");
    });
    return () => controller.abort();
  }, [sessionId, ready]);

  async function sendMessage(rawMessage: string): Promise<void> {
    const message = rawMessage.trim();
    if (!message || !ready || busy) return;
    setInput("");
    setError(undefined);
    setMessages((current) => [...current, { role: "user", text: message }]);
    setBusy(true);
    try {
      const response = await runAgent(message, sessionId);
      setSessionId(response.sessionId);
      setMessages((current) => [...current, { role: "agent", text: response.result.message }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    await sendMessage(input);
  }

  function playMove(from: string, to: string): void {
    const candidates = legalMoves.filter((move) => move.from === from && move.to === to);
    if (candidates.length > 1) {
      setPendingPromotion({ from, to, moves: candidates });
      return;
    }
    const move = candidates[0];
    if (move !== undefined) void sendMessage(`Play ${move.uci}`);
  }

  function selectBoardSquare(square: string): void {
    if (busy || !ready) return;
    if (selectedSquare === undefined) {
      if (legalMoves.some(({ from }) => from === square)) setSelectedSquare(square);
      return;
    }
    if (selectedSquare === square) {
      setSelectedSquare(undefined);
      return;
    }
    if (legalMoves.some(({ from, to }) => from === selectedSquare && to === square)) {
      const from = selectedSquare;
      setSelectedSquare(undefined);
      playMove(from, square);
      return;
    }
    setSelectedSquare(legalMoves.some(({ from }) => from === square) ? square : undefined);
  }

  function dropPiece(event: DragEvent<HTMLButtonElement>, target: string): void {
    event.preventDefault();
    const from = event.dataTransfer.getData("text/plain");
    if (/^[a-h][1-8]$/.test(from)) playMove(from, target);
    setSelectedSquare(undefined);
  }

  function openMoment(moment: ReviewMomentEvent): void {
    setSelectedMoment(moment);
    setVariationIndex(0);
    setFen(moment.fenBefore);
  }

  function showVariationPly(index: number): void {
    if (selectedMoment === undefined) return;
    const rules = new ChessRules(selectedMoment.fenBefore);
    for (const move of selectedMoment.bestLine.slice(0, index)) rules.makeMove(move);
    setVariationIndex(index);
    setFen(rules.state().fen);
  }

  async function connectLichess(): Promise<void> {
    setError(undefined);
    try {
      const response = await fetch("/v1/oauth/lichess/start");
      if (!response.ok) throw new Error("Could not start Lichess connection");
      const body = await response.json() as { authorizationUrl: string };
      window.location.assign(body.authorizationUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not connect Lichess");
    }
  }

  function sendSuggestion(message: string): void {
    setInput(message);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div><span className="mark">♞</span><strong>Chess Agent</strong></div>
        <div className="account"><span className="connection">{connection.lichessConnected ? `Lichess: ${connection.username ?? "connected"}` : ready ? "Lichess not connected" : "Starting local session…"}</span><button onClick={() => void connectLichess()} disabled={!ready}>{connection.lichessConnected ? "Reconnect" : "Connect Lichess"}</button></div>
      </header>
      <section className="workspace">
        <div className="board-panel">
          {clock && <div className="clock-row">
            <span className={clock.running === "black" ? "running" : ""}>Black {formatClock(clock.blackMs)}</span>
            <button onClick={() => setOrientation((value) => value === "white" ? "black" : "white")}>Flip board</button>
            <span className={clock.running === "white" ? "running" : ""}>White {formatClock(clock.whiteMs)}</span>
          </div>}
          <div className="board" aria-label="Chess board">
            {displaySquares.map(({ piece, row, column, square }) => {
              const isLastMove = lastMove?.slice(0, 2) === square || lastMove?.slice(2, 4) === square;
              return <button type="button" aria-label={square} draggable={piece !== ""} onDragStart={(event) => { event.dataTransfer.setData("text/plain", square); setSelectedSquare(square); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropPiece(event, square)} onClick={() => selectBoardSquare(square)} key={`${row}-${column}`} className={`square ${(row + column) % 2 === 0 ? "light" : "dark"}${selectedSquare === square ? " selected" : ""}${legalTargets.has(square) ? " legal-target" : ""}${isLastMove ? " last-move" : ""}`}>
                <span>{PIECES[piece] ?? ""}</span>
              </button>;
            })}
          </div>
          {pendingPromotion && <div className="promotion-picker" role="dialog" aria-label="Choose promotion piece">
            <span>Promote to</span>
            {pendingPromotion.moves.map((move) => <button key={move.uci} onClick={() => { setPendingPromotion(undefined); void sendMessage(`Play ${move.uci}`); }}>{move.promotion?.toUpperCase()}</button>)}
            <button onClick={() => setPendingPromotion(undefined)}>Cancel</button>
          </div>}
          {analysis && <section className="analysis-progress">
            <div><strong>Stockfish review</strong><span>{analysis.error ?? `${analysis.progress}%`}</span></div>
            <progress value={analysis.progress} max="100" />
          </section>}
          <div className="position-meta"><span>Current position</span><code>{fen}</code></div>
          {moveHistory.length > 0 && <div className="move-history" aria-label="Move history">
            {Array.from({ length: Math.ceil(moveHistory.length / 2) }, (_, index) => <div key={index}>
              <span>{index + 1}.</span><button onClick={() => setInput(`Explain ${moveHistory[index * 2]?.san}`)}>{moveHistory[index * 2]?.san}</button><button onClick={() => setInput(`Explain ${moveHistory[index * 2 + 1]?.san}`)}>{moveHistory[index * 2 + 1]?.san ?? ""}</button>
            </div>)}
          </div>}
          {activeGameId && <div className="game-actions">
            {gameStatus === "created" && <button onClick={() => void sendMessage(`Cancel challenge ${activeGameId}`)} disabled={busy}>Cancel challenge</button>}
            {gameStatus === "started" && <><button onClick={() => void sendMessage(`Offer a draw in game ${activeGameId}`)} disabled={busy}>Offer draw</button><button onClick={() => void sendMessage(`Accept the draw offer in game ${activeGameId}`)} disabled={busy}>Accept draw</button><button onClick={() => void sendMessage(`Decline the draw offer in game ${activeGameId}`)} disabled={busy}>Decline</button></>}
            {gameStatus === "started" && <button className="danger" onClick={() => { if (window.confirm("Resign this game?")) void sendMessage(`Resign game ${activeGameId}`); }} disabled={busy}>Resign</button>}
            {gameStatus !== undefined && gameStatus !== "created" && gameStatus !== "started" && <button onClick={() => void sendMessage(`Request a rematch for game ${activeGameId}`)} disabled={busy}>Rematch</button>}
          </div>}
          {puzzle && <section className="learning-card">
            <div><strong>Puzzle {puzzle.rating}</strong><span>{puzzle.themes.join(" · ")}</span></div>
            {puzzle.feedback && <p>{puzzle.feedback}</p>}
            <div className="card-actions">
              <button onClick={() => sendSuggestion("Give me a small hint for this puzzle")}>Small hint</button>
              <button onClick={() => sendSuggestion("Give me a stronger hint for this puzzle")}>Stronger hint</button>
            </div>
          </section>}
          {review && <section className="learning-card review-card">
            <div><strong>Critical moments</strong><span>{review.moments.length} selected</span></div>
            <div className="moment-list">
              {review.moments.map((moment) => <button key={moment.ply} onClick={() => openMoment(moment)}>
                <span>Move {Math.ceil(moment.ply / 2)}{moment.ply % 2 === 0 ? "…" : ""}</span>
                <strong>{moment.classification}</strong>
                <small>{moveSan(moment.fenBefore, moment.playedMove)} → {moment.bestMove === undefined ? "—" : moveSan(moment.fenBefore, moment.bestMove)} · {(moment.lossCentipawns / 100).toFixed(1)}</small>
              </button>)}
            </div>
            {selectedMoment && <div className="variation-nav">
              <button disabled={variationIndex === 0} onClick={() => showVariationPly(variationIndex - 1)}>Previous</button>
              <span>{variationIndex === 0 ? "Position before the mistake" : `Best line ${variationIndex}/${selectedMoment.bestLine.length}`}</span>
              <button disabled={variationIndex >= selectedMoment.bestLine.length} onClick={() => showVariationPly(variationIndex + 1)}>Next</button>
            </div>}
          </section>}
        </div>
        <div className="chat-panel">
          <div className="messages" aria-live="polite">
            {messages.map((message, index) => <div key={index} className={`message ${message.role}`}>{message.text}</div>)}
            {busy && <div className="message agent thinking">Thinking…</div>}
          </div>
          {error && <div className="error">{error}</div>}
          <form onSubmit={(event) => void submit(event)}>
            <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Start a game, review my last game…" aria-label="Message" />
            <button disabled={busy || !input.trim() || !ready}>Send</button>
          </form>
        </div>
      </section>
    </main>
  );
}

function formatClock(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function moveSan(fen: string, move: string): string {
  try { return new ChessRules(fen).makeMove(move).san; } catch { return move; }
}

function loadLastReview(): ReviewView | undefined {
  try {
    const raw = localStorage.getItem("chess-agent-last-review");
    if (raw === null) return undefined;
    const value = JSON.parse(raw) as { reviewId?: unknown; criticalMoments?: unknown };
    return typeof value.reviewId === "string" && Array.isArray(value.criticalMoments)
      ? { id: value.reviewId, moments: value.criticalMoments as ReviewMomentEvent[] }
      : undefined;
  } catch {
    return undefined;
  }
}
