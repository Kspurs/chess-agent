# Chess Agent

A Codex-like conversational chess platform for web and CLI. The model interprets
intent and selects typed tools; deterministic services own chess rules, Lichess
state, Stockfish analysis, reviews, puzzles, authorization, and fair play.

## What works

- Lichess OAuth PKCE, encrypted credentials, recent games, AI games, moves, resign
- Legal chess state with SAN/UCI/FEN/PGN handling
- Bounded OpenAI Responses tool loop with six initial tools
- Live human-game assistance denial enforced below the model
- Bounded Stockfish jobs, cache, MultiPV and mate/centipawn parsing
- Grounded completed-game reviews and adaptive puzzle sessions
- Fastify API with authentication, rate limits, session ownership, SSE and replay
- React chat/board UI and interactive Unicode CLI
- Strict TypeScript, linting, unit/contract tests, behavior evals, and CI

## Commands

```bash
pnpm install
pnpm lint
pnpm check
pnpm test
pnpm eval
pnpm build
```

Configuration and local/deployment instructions are in
`infrastructure/.env.example`, `infrastructure/README.md`, and `docs/mvp.md`.

## Repository map

```text
apps/       API, web, CLI, and deferred desktop shell boundary
packages/   chess domain, event protocol, platform adapters, tools, runtime
services/   Stockfish engine, review pipeline, puzzle training
prompts/    system policy and workflow skills
evaluations deterministic agent-policy scenarios
docs/       architecture, data, MVP, and security decisions
infrastructure containers, proxy, local services, and configuration
```
