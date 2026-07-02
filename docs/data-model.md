# Data model

The current vertical slice uses in-memory repositories behind interfaces. The
production PostgreSQL schema follows these ownership rules.

| Aggregate | Important fields | Retention/relationship |
|---|---|---|
| `users` | id, locale, rating, preferences | Root record; explicit deletion |
| `provider_identities` | user_id, provider, provider_user_id, encrypted_token | Unique per provider account |
| `conversations` | id, user_id, created_at | Owns ordered visible messages |
| `sessions` | id, user_id, mode, active resource IDs, expires_at | Ephemeral projection, Redis-backed |
| `games` | id, provider, provider_game_id, players, result, PGN | Immutable completed history |
| `analysis_jobs` | id, position hash, engine config, status | Queue state with bounded retention |
| `reviews` | id, game_id, engine provenance, generated_at | Owns critical moments |
| `critical_moments` | review_id, ply, FEN, loss, class, themes, verified PV | Immutable grounding evidence |
| `puzzles` | id, FEN, encrypted/isolated solution, rating, themes, source, license | Dataset provenance required |
| `puzzle_attempts` | user_id, puzzle_id, result, hints, rating delta | Learning history |
| `audit_events` | request_id, call_id, user_id, tool, result code, timestamp | No tool secrets or raw prompts |

Games and review evidence are append-only. Mutable session state references their
IDs and never replaces them. Engine cache keys contain FEN plus depth, MultiPV,
engine version, and options. Generated explanations store provenance to a review
and prompt/model version; they are not authoritative analysis.

Indexes are required on provider game IDs, user timelines, active job status,
position cache hashes, review/game foreign keys, and puzzle rating/themes. Database
migrations are forward-only and tested against a restored backup before deployment.

