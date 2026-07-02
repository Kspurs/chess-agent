# Architecture decisions

## Technology baseline

- Runtime: Node.js 24 LTS in production; TypeScript 5 with strict checking.
- Workspace: pnpm workspaces for strict, fast dependency linking using the Codex
  development runtime. Each package exposes ESM modules.
- Web: React with Vite. The API owns authentication and all provider credentials.
- API: Fastify over HTTP and WebSocket/SSE streams. REST starts commands and reads
  resources; the event stream carries agent, game, and job updates.
- Persistence: PostgreSQL for durable data and Redis for ephemeral sessions, queues,
  rate limits, and fan-out. The first local slice uses in-memory implementations
  behind the same interfaces.
- Validation: JSON Schema at transport boundaries, with TypeScript types generated
  or inferred from the schemas.
- Chess: `chess.js` for local rule validation and Stockfish for calculation.
- Testing: Vitest for unit and contract tests; agent behavior is tested through
  deterministic fake-model and fake-platform adapters.

## System boundaries

```text
web / desktop / CLI
        |
        v
API: authentication, sessions, transport, event delivery
        |
        v
agent runtime: context assembly and bounded tool loop
        |
        v
agent tools: schemas, authorization, validation, audit
        |
        +--> ChessPlatform --> Lichess adapter
        +--> review service --> engine service --> Stockfish
        +--> puzzle service
```

Clients never call Lichess or Stockfish directly. The runtime cannot mutate stored
state directly; it can only request registered tools. Tools contain no model logic.
Services contain deterministic business logic and are independently testable.

## State ownership

| State kind | Examples | Authority and lifetime |
|---|---|---|
| Authoritative | moves, FEN, result, clocks, puzzle solution | Chess provider or domain service; durable |
| Session | active game/review/puzzle, selected ply, mode | Server-side session store; expires |
| Conversation | user messages, tool calls, visible responses | Conversation store; retained by policy |
| Long-term memory | preferences, rating, recurring weaknesses | User profile; explicit provenance and deletion |
| Working state | tool results and intermediate model context | Agent run only; discarded after tracing policy |

Conversation and model memory may reference authoritative IDs, but may never replace
authoritative chess state. A tool reloads current state before every mutation.

## Lichess boundary and fair play

Lichess is the initial provider for identity, games, matchmaking, and game records.
`ChessPlatform` uses provider-neutral IDs and domain objects; Lichess DTOs remain
inside its adapter. The adapter owns OAuth PKCE, token refresh, NDJSON streams,
rate-limit backoff, and provider error normalization. Contract tests must also pass
for a future native provider.

During an active human-versus-human game, the capability policy permits game control
only: read the current state, submit the user's chosen move, offer/accept a draw, or
resign. Analysis, hints, candidate moves, opening retrieval, and coaching are denied
by the tool executor. Prompt instructions are defense in depth, not enforcement.

## MCP decision

MCP is not part of the first vertical slice. Internal TypeScript interfaces remain
the source of truth while tool schemas are changing quickly. Add a thin MCP adapter
only after all of these are true:

1. Tool names and schemas have remained compatible across two releases.
2. Authorization is enforced below the adapter.
3. Contract tests cover success, error, and policy-denial behavior.
4. A real second consumer needs tool discovery or remote invocation.

MCP handlers will delegate to the same application services as HTTP and the agent;
they will not contain chess business logic.

## Initial deployment shape

Deploy the web/API process, background review workers, PostgreSQL, and Redis as
separate units. Stockfish runs only in resource-limited workers. This is a modular
monolith at the code level: packages may be deployed together until workload or
security boundaries justify extracting a service.
