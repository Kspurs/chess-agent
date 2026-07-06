# Infrastructure

## Local services

`docker compose up --build` starts the API, web proxy, PostgreSQL, and Redis. The
vertical slice persists encrypted credentials, agent sessions, and history in the
mounted API data volume. PostgreSQL and Redis establish the production migration
boundary without changing domain interfaces.

Required secrets are documented in `.env.example`. Never commit populated `.env`
files. Stockfish runs in the API image with one thread, bounded hash, request depth
limits, and a bounded worker pool.

The API uses Ollama at `MODEL_BASE_URL` by default. A host-native API normally uses
`http://127.0.0.1:11434`; the Docker API uses `http://host.docker.internal:11434`.
The selected model must support native tool calling. `qwen3:4b` is the lightweight
default for 8 GB Apple Silicon systems.

## Production units

- Web static assets behind a TLS CDN/reverse proxy
- Stateless API replicas
- Review/Stockfish workers with CPU and memory limits
- PostgreSQL with point-in-time recovery and encrypted backups
- Redis for sessions, queues, rate limits, and event fan-out

Health checks cover process liveness, database/Redis connectivity, queue age, and
engine readiness. Metrics include request/error latency, tool denials, model usage,
Lichess 429s, engine queue depth, analysis duration, and agent step-limit failures.
Trace IDs connect API requests, tool audits, and background jobs without recording
private reasoning or credentials.

Deploy migrations before application rollout, use rolling health-gated releases,
and retain the previous image for rollback. Restore backups in a scheduled drill.
