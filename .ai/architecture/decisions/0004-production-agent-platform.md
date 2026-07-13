# ADR 0004: Production agent platform evolution

Status: Accepted

## Context

The existing application proves the operator workflow with a deterministic planner and a local SQLite ledger, but its cloud provider is a readiness placeholder. Production operation requires real model execution, durable role separation, bounded failure behavior, auditable usage, deployable storage, authentication, telemetry, and backwards-compatible local development.

## Decision

- Keep SvelteKit and the Node adapter as the product shell.
- Introduce provider adapters behind a framework-neutral structured-completion contract. OpenAI Responses API is the first production adapter; deterministic execution remains an explicit test/local provider.
- Preserve planner, executor, and verifier as separate calls and persist their raw evidence and provider usage.
- Evolve storage through versioned migrations. SQLite remains supported for single-node/local operation; PostgreSQL becomes the clustered production backend.
- Keep credentials server-only, validate every request at trust boundaries, apply hard run/token/cost/time ceilings, and require code-enforced tool scope.
- Emit structured logs, metrics, traces, health/readiness state, and immutable audit events.

## Impact

Provider failures and cost become real operational concerns. Run creation becomes asynchronous and storage gains migrations. Production deployments require explicit secrets, a shared database, TLS termination, and an authenticated operator identity. Existing deterministic tests remain fast and offline.

## Rollback

1. Set `KCEV_AGENT_PROVIDER=deterministic-local` to stop remote execution without data loss.
2. Roll back the application image while retaining additive database columns/tables.
3. Disable new workers before reverting a migration; migrations must provide a tested down path where destructive rollback is unavoidable.
4. Export the run ledger before any schema rollback and verify row counts and checksums afterward.

## Verification

- Contract tests mock all provider response states, including refusal, timeout, rate limit, malformed output, and success.
- End-to-end tests exercise planner -> executor -> verifier with an injected provider.
- Production smoke checks cover database readiness, provider readiness, health endpoints, cancellation, and audit persistence.
