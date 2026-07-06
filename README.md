# Chess Agent

A local-first conversational chess platform for web and CLI. The model interprets
intent and selects typed tools; deterministic services own chess rules, Lichess
state, Stockfish analysis, reviews, puzzles, authorization, and fair play.

## What works

- Lichess OAuth PKCE, encrypted credentials, recent games, AI games, human challenges, moves, resign
- Legal chess state with SAN/UCI/FEN/PGN handling
- Bounded OpenAI Responses tool loop with six initial tools
- Local Ollama/Qwen3 tool loop by default; OpenAI remains an optional provider
- Live human-game assistance denial enforced below the model
- Bounded Stockfish jobs, cache, MultiPV and mate/centipawn parsing
- Grounded completed-game reviews and adaptive puzzle sessions
- Fastify API with authentication, rate limits, session ownership, SSE and replay
- React chat/board/review/puzzle UI, interactive Unicode CLI, and Tauri desktop shell
- Durable encrypted credentials plus persisted agent sessions and history
- Strict TypeScript, linting, unit/contract tests, behavior evals, and CI

## Commands

```bash
pnpm install
pnpm lint
pnpm check
pnpm test
STOCKFISH_PATH=/path/to/stockfish pnpm test:stockfish
pnpm eval
pnpm build
```

Run the terminal client after starting the API:

```bash
pnpm --filter @chess-agent/cli start:local
```

It creates a secure local session automatically. Use `CHESS_AGENT_API_URL` for a
non-default API address, or `CHESS_AGENT_TOKEN` when connecting remotely.

The default local model is `qwen3:4b` through Ollama. On macOS, install it with
`brew install ollama`, start it with `brew services start ollama`, and run
`ollama pull qwen3:4b`. Set `MODEL_PROVIDER=openai` and provide
`OPENAI_API_KEY` only when intentionally using the hosted fallback.

Configuration and local/deployment instructions are in
`infrastructure/.env.example`, `infrastructure/README.md`, and `docs/mvp.md`.

## Repository map

```text
apps/       API, web, CLI, and Tauri desktop shell
packages/   chess domain, event protocol, platform adapters, tools, runtime
services/   Stockfish engine, review pipeline, puzzle training
prompts/    system policy and workflow skills
evaluations deterministic agent-policy scenarios
docs/       architecture, data, MVP, and security decisions
infrastructure containers, proxy, local services, and configuration
```
