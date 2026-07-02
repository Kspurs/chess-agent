# Security and fair play

## Capability policy

The tool executor is the enforcement boundary. During an active human game it
denies reviews, puzzles, engine analysis, hints, and coaching. Game-control tools
still re-read authoritative state, verify participant ownership and side to move,
and use optimistic revisions. Prompt rules provide defense in depth only.

## Authentication and secrets

- The API accepts an application bearer token through an `Authenticator` interface.
  The local composition supplies a single-user token; production must replace it
  with signed, expiring sessions stored in secure, HTTP-only cookies.
- Lichess uses OAuth authorization code with PKCE (`S256`). State is single-use,
  user-bound, expires after ten minutes, and is consumed before token exchange.
- Lichess access tokens are encrypted with AES-256-GCM before reaching storage.
  The encryption key and OpenAI key come only from the server environment.
- Browser and desktop bundles never receive provider or OpenAI credentials.
- Logs, traces, errors, and audit records exclude tokens and private model reasoning.

## Threat model and controls

| Threat | Control |
|---|---|
| Prompt injection requests analysis in a live game | Tool-level capability denial |
| Cross-game or cross-session action | Participant checks and session ownership |
| Stale/replayed move | Expected revision plus authoritative reload |
| Duplicate state mutation | Per-call idempotency keys |
| OAuth login CSRF | Random, expiring, single-use state and PKCE |
| Token database disclosure | AES-GCM envelope encryption and external key |
| Provider/engine abuse | Per-user API limits, serialized Lichess calls, bounded engine pool |
| Internal-detail leakage | Normalized public errors and bounded trace fields |

## Data lifecycle

Production storage must expose account export and deletion. Deletion removes
conversations, session projections, memories, reviews, attempts, provider mappings,
encrypted credentials, and audit identifiers according to the configured retention
policy. Immutable security audits may be retained only for a documented legal or
abuse-prevention period and must replace user IDs with deletion tombstones.

## Incident response

Revoke suspected Lichess/OpenAI credentials, rotate encryption and application
keys, invalidate sessions, preserve scoped audit evidence, notify affected users,
and record remediation. Engine and model services fail closed for state mutations.

