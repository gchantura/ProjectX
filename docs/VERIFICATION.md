# Production verification record

This record maps the requested product requirements to current authoritative evidence. It describes the repository and runtime as verified on 2026-07-13; deployment-specific credentials, provider pricing, origins, and tenant IDs remain operator configuration.

## Requirement evidence

| Requirement | Status | Authoritative evidence |
|---|---|---|
| Real integrations | Verified | Production adapters under `src/lib/agent/providers` call OpenAI Responses, Anthropic Messages, Gemini generateContent, xAI chat completions, Ollama chat, and local OpenAI-compatible chat-completions runtimes. Adapter contract tests validate authentication, request schemas, usage, retry, refusal, malformed output, and failure behavior. Live probes gate execution. |
| Robust workflows | Verified | `runStream.server.js` implements admission, planning, execution, verification, dependency order, streaming, retry, checkpoint rollback, escalation, stop, resume, persistence, and completion. Lifecycle and recovery tests exercise success and failure paths. |
| Agent responsibilities | Verified | Planner, competing planner candidates, Adjudicator, single-step Executor, independent Verifier, and Orchestrator boundaries are implemented in `agentPipeline.server.js` and `runStream.server.js` and documented in `ARCHITECTURE.md`. |
| Persistent memory | Verified | Tenant/project-scoped Supabase memory supports bounded remember, ranked recall, expiry, deletion, secret rejection, verified-run recording, and idempotent source-run deduplication. |
| Tenant isolation | Repository verified | Personal tokens resolve server-side to one globally unique home identity. V3 HttpOnly sessions sign the home account, selected organization, and organization role; every request resolves that exact membership before installing tenant context. Company SSO seals its server-resolved organization plus tenant-owned IdP revision into signed PKCE state and requires one unambiguous federated membership. OIDC client secrets use key-identified AES-256-GCM with tenant and key-ID authenticated data; metadata reads expose neither ciphertext nor plaintext. Versioned keyrings retain v1 migration support, optimistic re-encryption prevents overwriting concurrent credential changes, and diagnostics block key retirement claims while records remain stale. Tests prove exact home/target membership resolution, immediate membership revocation, viewer self-service switching, home-role ownership, global account revocation propagation, tenant-admin denial, platform allowlist revocation, digest-only provisioning, self-lockout prevention, suspended-tenant rejection, encrypted-secret integrity and cross-tenant/key-ID swap rejection, environment-fallback isolation, provider-revision substitution denial, cross-tenant SSO membership denial, session invalidation after tenant substitution, and redacted rotation reporting. Live two-organization Supabase and real-IdP evidence still require a deployed migrated tenant pair. |
| Multi-agent orchestration | Verified | Multi-hypothesis planners execute concurrently, invalid hypotheses are isolated, a bounded repair is available, adjudication preserves competing traces, and execution cannot self-verify. |
| Error handling | Verified | Provider errors are normalized; timeouts, cancellation, bounded retry, malformed output, refusals, invalid graphs, unresolved templates, tool failures, budget stops, rollback refusal, and repeated verifier rejection fail visibly. |
| Monitoring and observability | Verified | Liveness, readiness, diagnostics, governance, SLOs, Operations UI, Prometheus metrics, saturation gauges and alerts, W3C trace propagation, recursively redacted structured logs, persisted event replay, request IDs, and hash-addressed audit exports are implemented. |
| Testing | Verified | `npm run ai:test` covers orchestration, providers, storage, request-bound tenant isolation, identity, OIDC, memory, security, governance, budgets, tools, recovery, audit, diagnostics, automation, deployment manifests, graceful shutdown, telemetry, local runtime inventory, and AI policy contracts. Tests use isolated stores and do not erase operator state. |
| Documentation | Verified | `README.md`, `ARCHITECTURE.md`, `USER_WORKFLOW.md`, `PRODUCTION.md`, MCP setup, environment reference, migration, ADRs, and this evidence record cover development, operation, security, recovery, extension, and deployment. |
| Deployment artifacts | Repository verified | Adapter-node build, managed graceful server, bounded per-replica admission, CI latency/error capacity gate, hardened multi-stage image, checksum-locked migration image, Kubernetes rolling deployment, probes, PDB, HPA, network policy, CI provenance/SBOM builds, backup, and rollback contracts are present and structurally tested. OCI execution still requires a Docker/BuildKit environment. |
| Existing `tokens.css` | Verified | `src/routes/layout.css` imports the existing root `tokens.css`; the operator console, login, settings, modules, and ledger views share that design system. |
| Serious production UI | Verified | Live browser inspection confirmed the responsive dark technical console, exact empty states, provider/model controls, governance, diagnostics, SLOs, maintenance, approvals, memory, timeline, inspector, ledger navigation, active-organization switching, and membership administration. The 360, 768, 1280, and 1600 pixel viewport matrix had no horizontal overflow or overlapping controls. Fabricated initial run data and stale scaffold language were removed. |
| No placeholders, TODOs, fake data, or incomplete provider paths | Verified | Production-source search found no TODO/FIXME/mock/fake/scaffold implementation markers. Form placeholder attributes and the Planner’s internal edit placeholder contract are intentional interaction/runtime mechanisms, not missing implementation. |

## Real local-model evidence

Ollama exposed six installed models through the live local runtime:

- `ornith:9b`
- `freehuntx/qwen3-coder:14b`
- `qwen3.6:latest`
- `gemma4:31b`
- `gemma4:latest`
- `qwen2.5-coder:14b`

Final end-to-end run:

- Run ID: `run-a69bf545-a5da-4474-b5b1-c5e65d82bf94`
- Provider/model: `local-ollama` / `ornith:9b`
- Live capability probe: ready, 100% reliability, `live-ollama-api`, 72 tokens
- Governance: admitted by the measured provider/model readiness gate
- Result: verified
- Actual model usage: 5,924 tokens
- Tool: real `inspect_context` read of `PROJECT_MAP.md` under the configured path allowlist
- Verification: independent positive evidence including the `# Project Map` heading and project/file structure
- Persistence: verified run document and replayable lifecycle events
- API cost: zero, because execution was local

The diagnostics layer also inventories Ollama model manifests on disk when the service is not running, while provider readiness still requires a live structured-output probe before execution is admitted. Local OpenAI-compatible runtimes such as LM Studio, llama.cpp server, vLLM, and text-generation-webui are supported through `KCEV_LOCAL_OPENAI_BASE_URL`.

## Production runtime smoke evidence

The compiled adapter was started through `tools/server.mjs` against the isolated Supabase test store:

- Liveness: HTTP 200
- Managed server startup: structured `server.started` event
- W3C `traceparent`: present
- Request ID: present
- Graceful drain behavior: automated test passed
- Capacity contract: 1,000 requests at concurrency 50 against the built `/api/modules` route; 2,930.17 requests/second, 21.66 ms p95, 30.09 ms maximum, zero errors
- Saturation behavior: excess traffic receives HTTP 503 with retry and concurrency headers, liveness remains available, and ordinary traffic recovers after capacity is released

The workstation does not have Docker installed, so the OCI images were not executed locally. CI builds both images with BuildKit provenance and SBOM attestations. Live deployment readiness remains intentionally unproven until the target Supabase migrations, secrets, immutable image digests, ingress, and workspace volume are applied and `/api/health/ready` passes in that environment.

## Quality gates

```text
npm run ai:sync  -> passed
npm run ai:check -> passed
npm run ai:test  -> passed (231 tests)
npm run build    -> passed
capacity contract -> passed (1,000 requests, p95 21.66 ms, 0% errors)
svelte-package   -> passed
publint          -> passed
```

Node 24 is the verified build and runtime major.

## Cloud operational boundary

Cloud adapters are real and contract-tested but live cloud calls require operator-owned credentials, configured models, and current provider-specific prices. KcevAgent intentionally blocks those providers until a live structured-output probe succeeds for the exact provider/model pair. This is a deployment readiness control, not a fallback or simulated success path.
