# KcevAgent architecture

## System purpose

KcevAgent is an evidence-driven agent operations platform for bounded workspace tasks. It separates planning, execution, verification, policy enforcement, persistence, and operations instead of giving one model unrestricted tools and trusting its self-reported result.

## Runtime topology

```text
Operator browser
  |  authenticated REST + NDJSON
  v
SvelteKit / Node application
  |-- admission: security + governance + provider/model readiness + budgets
  |-- planner candidates ----+
  |-- plan adjudicator       | model provider adapter
  |-- single-step executor   |
  |-- independent verifier --+
  |-- code-enforced tool registry
  |-- run/event/ledger store
  |-- durable memory store
  |-- diagnostics, SLOs, maintenance, metrics
  v
Tenant-scoped Supabase Postgres
```

The browser never calls a model provider directly and never receives provider credentials. It sends objectives and configuration to server routes, consumes an NDJSON event stream, and renders persisted evidence.

## Agent responsibilities

### Orchestrator

The run stream coordinates the task graph, executes only dependency-ready steps, applies token/cost/step ceilings, performs one bounded retry, triggers checkpoint rollback after validation failure, persists lifecycle events, and escalates repeated verification failure. Admission creates a signed execution-context snapshot binding organization, project, canonical workspace, repository commit, actor, request correlation, provider, autonomy mode, ceilings, and project policy. Resume re-resolves the project and policy and rejects drift before execution. Every new or resumed execution also holds a tenant-scoped Supabase lease. Atomic claims reject concurrent workers, heartbeats renew ownership before effects, expired leases allow recovery after worker death, and token-matched release runs in `finally`. It does not grant tool authority; the registry does.

### Planner

The Planner emits structured task-graph steps with exact IDs, backward dependencies, risk, tool, arguments, and evidence requirements. Multi-hypothesis mode requests minimal-risk and maximum-leverage candidates concurrently. Invalid candidates are retained as rejected evidence; a bounded repair is allowed only when both are invalid.

Planning and execution are separate persisted phases. Preflight stores the exact normalized task graph with a SHA-256 fingerprint and creates a tenant/project-scoped pending approval. The browser receives a random one-time token while only its hash is stored. Approval atomically verifies the token hash, plan fingerprint, pending decision, and expiry; the approved stream executes those persisted steps without calling the Planner again. Discarding a plan records a durable rejection event.

### Adjudicator

The Adjudicator compares valid candidates for evidence coverage, dependency correctness, reversibility, validation, scope, and cost. It selects rather than merging plans, preserving both hypotheses in the audit trace.

### Executor

The Executor performs exactly one planned step. Read-only and validation tools use normalized planner arguments. Source edits require completed inspection and impact evidence; the model produces an exact replacement that is revalidated by code before the atomic write.

### Verifier

The Verifier receives the stated goal, evidence requirement, tool success flag, raw output, and system evidence. A step passes only with positive evidence. Empty evidence, malformed output, refusals, tool errors, and uncertainty fail closed.

## Provider architecture

Adapters implement strict structured completion for OpenAI Responses, Anthropic Messages, Gemini generateContent, xAI chat completions, and Ollama chat. Each adapter owns authentication, request schema, timeout, cancellation, bounded retry, error normalization, response parsing, refusal handling, request IDs, and usage capture.

Readiness is measured for the exact provider/model pair. A successful probe for one model never authorizes another. Cloud models are configured server-side; Ollama models are discovered from the live runtime. New and resumed runs pass the same readiness and governance admission.

Provider pricing is also isolated by provider. Positive cloud cost ceilings require configured per-provider input and output rates; missing rates block admission. Local execution has zero API cost.

## Tool and sandbox boundary

The coding module registers nine tools:

- Workspace reads: list, search, context inspection, Git diff inspection, impact analysis.
- Sandboxed artifact write under `.kcevagent/artifacts`.
- Approval-gated source write.
- Atomic exact-match source edit with optimistic hash checking and checkpoints.
- Allowlisted validation commands with hard timeout.

All paths are canonicalized and checked against the workspace and configured source roots. Every admitted tool call also validates the signed execution context against its active configuration, so a mutated project, policy, provider, autonomy mode, or ceiling fails closed. The model cannot add tools, expand roots, choose arbitrary shell commands, bypass approval, or write through prompt instructions. Tool output is always treated as untrusted data.

## Persistence and memory

Supabase Postgres is the authoritative persistence layer. Authentication resolves a globally unique credential digest to one home identity. Audited organization memberships attach that account to additional tenants with independent roles. A v3 HttpOnly session signs both the immutable home-account tenant and selected tenant; every request resolves that exact three-part membership and rejects revoked accounts, revoked memberships, role drift, and suspended organizations before installing request-local tenant context. Existing v2 sessions remain readable as home-only sessions during rollout. Browser headers and query parameters cannot select a tenant, and a switch request can only choose an active membership returned by the service-role directory. Every tenant store derives its UUID from authenticated async context. Tables use tenant-scoped keys, RLS is enabled, and browser roles have no direct table access. Transactional RPCs own run persistence, worker leases, preflight approval decisions, identity and membership lifecycle changes, organization provisioning and status changes, tenant OIDC revisions, and revocation audit events. Provisioning creates the tenant, first administrator digest, identity event, and home membership in one transaction through the identity trigger. Suspension takes a row lock, changes admission state, and appends its lifecycle event in one transaction. Tenant OIDC client secrets are key-identified AES-256-GCM envelopes bound to the tenant UUID and key ID as additional authenticated data; metadata APIs never return ciphertext or plaintext. Platform key rotation decrypts only inside the operator process, re-encrypts with the active key, compares the inspected revision under a row lock, rotates the OIDC revision, and records old/new key IDs without credential material.

Durable memory is bounded, project-scoped, ranked, expirable, deduplicated by verified source run, and rejects secret-like content. Failed and stopped runs are not recorded as successful outcome memory.

## Reliability state machine

```text
admission -> planning -> running -> verified
                         |   |
                         |   +-> stopped -> readmission -> running
                         |
                         +-> retrying -> verified
                                  |
                                  +-> rollback -> needs_attention
```

Every transition is emitted and persisted. New runs transition through `awaiting_approval` before `running`. Resume begins at the first non-verified step and reuses the persisted provider/model adapter. No state becomes verified solely because an operation returned without an exception.

## Security model

Production requires an active named identity or the removable bootstrap administrator credential. Personal access tokens are stored only as SHA-256 digests. Browser login exchanges a token for an HMAC-signed, Secure, HttpOnly, SameSite=Strict session containing the subject, home account, selected organization, organization-specific role, and platform-authority claim. Every request revalidates durable identity status, exact membership, organization status, role, tenant, and current platform-admin allowlist, so account revocation, membership removal, tenant suspension, and authority changes take effect immediately. Personal tokens discover their home tenant from the globally unique server-side digest. Company SSO resolves a human-readable organization slug and tenant-owned IdP configuration before redirect. Signed PKCE state binds the tenant and a fingerprint of the current OIDC revision; callback refuses a rotated, disabled, or substituted configuration before exchanging the code. It resolves exactly one federated account membership, rejects ambiguity, and audits the login against the immutable home identity with the selected organization recorded as evidence. `viewer`, `operator`, and `admin` permissions are enforced in the server hook. Tenant administrators own their OIDC connection but never retrieve its secret. Platform administration is independent of tenant roles and protects `/api/platform/*`; its lifecycle API also prevents an administrator from suspending the organization that owns the current session. Administrative routes never rely on hidden UI controls for authorization. State changes enforce trusted origins; all requests are rate limited and receive request IDs, CSP nonces, and security headers.

Provider and Supabase credentials remain server-only. Logs and diagnostics redact credential-shaped fields. Metrics intentionally avoid tasks, prompts, run IDs, models, paths, raw outputs, and tenant identifiers as labels.

## Observability

The HTTP boundary accepts W3C `traceparent`, preserves a valid upstream trace ID, creates a new server span, and returns the resulting trace context with the request ID. Async-local telemetry context automatically enriches downstream run, lease, maintenance, and HTTP logs with trace, span, request, actor, and role correlation. Structured fields are recursively bounded and credential-shaped keys are removed at every nesting level.

Prometheus counters and histograms are process-local by design and must be scraped from every replica. Tenant SLOs, incidents, run outcomes, lease ownership, pending approvals, dependency health, and audit evidence are derived from authoritative Supabase records and remain coherent across replicas. The Operations surface combines both scopes while labeling process telemetry as instance-specific.

## Operations

Liveness is process-only. Readiness checks storage, memory, production authentication, event replay, providers, and Ollama inventory. Governance turns these checks into an admission decision. The SLO report derives reliability from persisted runs rather than process counters alone.

Maintenance is an idempotent endpoint intended for an external scheduler. Prometheus metrics cover HTTP traffic, maintenance, run lifecycle, step outcomes, tokens, duration, estimated cost, lease claims, contention, lost ownership, and release outcomes. Storage readiness verifies the lease table and reports active lease depth. Audit export includes execution context, public lease events, correlation and policy fingerprints, then hashes every component and the complete bundle for portable verification.

## Extension points

- Add a provider by implementing the structured adapter, live probe, registry metadata, error mapping, usage capture, and contract tests.
- Add a domain module by registering tools with explicit schemas, risk, permission metadata, and objective validators.
- Add a storage backend behind the run and memory store contracts without changing orchestration.
- Add a tool only with code-enforced scope, bounded output, timeout/cancellation behavior, audit evidence, and adversarial tests.

Architectural decisions are recorded under `.ai/architecture/decisions`; generated project maps describe current file relationships but do not replace this runtime design.
