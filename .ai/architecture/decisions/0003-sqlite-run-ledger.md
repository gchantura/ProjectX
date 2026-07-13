# 0003 SQLite Run Ledger

## Status

Accepted

## Context

The agent runtime needs auditable persistence for runs, steps, tool calls, verifications, and artifacts. JSONL snapshots are useful for early smoke tests but do not support reliable inspection, joins, or future cost/provider analytics.

## Decision

Persist run history in a local SQLite database at `.kcevagent/kcevagent.sqlite` using Node's built-in SQLite runtime. Keep the complete run JSON snapshot for API compatibility, and also write normalized child records for:

- `steps`
- `tool_calls`
- `verifications`
- `artifacts`

Use foreign keys with cascade delete, indexes on run lookup paths, and a schema version record.

## Consequences

- Run APIs can continue returning the existing run object shape.
- Operator views can inspect ledger counts and later drill into records.
- The local runtime avoids a native package dependency for now.
- Future hosted or multi-user deployments still need an explicit migration path, authorization model, and production database review.
