# ADR 0002: Node runtime for persisted agent runs

Status: accepted

## Decision

Use SvelteKit with the Node adapter for the agent application runtime. Persist run records server-side through a small run-store boundary under `src/lib/agent` and expose REST endpoints for creating, listing, and reading runs.

The first store is file-backed JSONL so the MVP has auditable run logs without native database installation friction. The store boundary keeps the path open for a SQLite implementation without changing browser UI contracts.

## Consequences

- The operator console can create and inspect runs through server APIs instead of only simulating state in the browser.
- The app is no longer a purely prerendered showcase; it needs a Node-capable host for the agent backend.
- File writes are isolated to `.kcevagent/`, which is ignored by Git.
- SQLite remains a planned storage engine behind the same run-store interface.
