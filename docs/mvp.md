# MVP vertical slice

## Implemented path

1. Authenticate the application user and connect Lichess through OAuth PKCE.
2. List and export the user's recent completed Lichess games.
3. Interpret requests through a bounded OpenAI Responses tool-calling loop.
4. Queue bounded Stockfish MultiPV jobs and expose progress/status.
5. Generate deterministic reviews with evaluation loss and critical positions.
6. Create and validate rated puzzle sessions without revealing solutions.
7. Render chat, board state, and UI actions in React; provide a Unicode CLI.
8. Replay typed session events through snapshots or an authenticated SSE stream.
9. Persist encrypted credentials, agent sessions, and conversation history locally.
10. Challenge a named human opponent on Lichess with validated clock/rating options.

## Run locally

1. Install Node 24, pnpm 11.7, and Stockfish.
2. Copy `infrastructure/.env.example` to `infrastructure/.env` and replace every
   placeholder with a real secret/configuration value.
3. Start Ollama and pull the configured local model (`qwen3:4b` by default).
4. Run `pnpm install`, `pnpm check`, `pnpm test`, and `pnpm build`.
   To exercise the real engine protocol, also run
   `STOCKFISH_PATH=/path/to/stockfish pnpm test:stockfish`.
5. Start the API with `pnpm --filter @chess-agent/api start:local`; this loads
   `infrastructure/.env` without exporting secrets into your shell.
6. Start the web dev server with `pnpm --filter @chess-agent/web dev`, or use
   `docker compose -f infrastructure/compose.yaml up --build`.
7. Enter the configured app token, connect Lichess, then ask “review my last game.”

## Desktop

The Tauri 2 shell in `apps/desktop` loads the canonical web bundle. Install the
Rust toolchain and platform prerequisites, then run
`pnpm --filter @chess-agent/desktop dev` or `build`.

## Explicitly deferred

Native multiplayer infrastructure, mobile, voice, social features, custom model
training and a full Lichess fork are outside the validated MVP. Native installers
require the platform Rust/Tauri toolchain and signing credentials.
