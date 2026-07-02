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

## Run locally

1. Install Node 24, pnpm 11.7, and Stockfish.
2. Copy `infrastructure/.env.example` to `infrastructure/.env` and replace every
   placeholder with a real secret/configuration value.
3. Run `pnpm install`, `pnpm check`, `pnpm test`, and `pnpm build`.
4. Start the API with `pnpm --filter @chess-agent/api start`.
5. Start the web dev server with `pnpm --filter @chess-agent/web dev`, or use
   `docker compose -f infrastructure/compose.yaml up --build`.
6. Enter the configured app token, connect Lichess, then ask “review my last game.”

## Explicitly deferred

Native multiplayer infrastructure, mobile, voice, social features, custom model
training, a full Lichess fork, and desktop packaging are outside the validated MVP.
The desktop boundary selects Tauri and reuses the web bundle when packaging begins.

