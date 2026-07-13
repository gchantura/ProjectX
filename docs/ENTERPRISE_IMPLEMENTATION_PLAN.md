# KcevAgent Enterprise Implementation Plan

## Product Standard

KcevAgent should become a governed autonomous engineering platform, not a dashboard that exposes every internal subsystem at once. Its core product promise is:

> Connect a real software project, describe an outcome, review an evidence-backed plan, and let a coordinated agent team execute, verify, and deliver a reversible change with a complete audit trail.

A USD 1M valuation cannot be guaranteed by a feature list. The credible path is to create defensible value: reliable execution on real repositories, measurable engineering outcomes, secure multi-tenant operations, differentiated organizational memory, and a workflow customers will pay to use repeatedly.

## Current-State Verdict

### Blocking product problems

1. **No project model.** Runtime tools use `process.cwd()` as the single global workspace. There are no persisted projects, repository connections, branches, environments, memberships, or project-scoped policies.
2. **Persistence is opaque.** Supabase support exists, but the default run and memory backends are SQLite. Creating Supabase tables does not activate Supabase. The UI reports generic storage health without identifying the authoritative backend, replication state, tenant, or last persisted record.
3. **The primary UI has no workflow hierarchy.** Task execution, history, guardrails, provider probes, diagnostics, SLOs, maintenance, approval, memory, hypotheses, and recommendations are rendered on one long page. Operator diagnostics displace the user’s actual job.
4. **The supplied design tokens are effectively bypassed.** `tokens.css` is imported, but `layout.css` directly hardcodes almost all colors and component values. Only two token variables are referenced. No semantic or component token layer exists.
5. **The agent fails ordinary intent.** A request to find logs caused `list_workspace` to target a disallowed root. The planner did not understand tool policy before producing the plan, and recovery repeated the same policy-invalid action.
6. **The product surface overclaims readiness.** Provider probe success is presented next to failed real task execution. Capability readiness and task success are different signals and must never be conflated.
7. **Memory is storage, not intelligence.** Current memories are short run summaries. There is no project knowledge graph, temporal model, source freshness, contradiction resolution, decision history, or retrieval evaluation.

### Assets worth preserving

- Provider adapters for OpenAI, Anthropic, Gemini, xAI, Ollama, and OpenAI-compatible local runtimes.
- Planner, executor, verifier separation and evidence-oriented run records.
- Scoped tools, approval gates, ceilings, cancellation, event replay, and provider probes.
- SQLite and tenant-scoped Supabase adapters.
- A meaningful automated test base.

These are useful foundations, but they are platform internals. They are not yet a coherent commercial product.

## Target Product Architecture

### Control plane

- Organizations, users, memberships, roles, API keys, billing plans, and audit events.
- Projects with stable IDs, repository connections, default branches, local worktrees, environments, and policy profiles.
- Provider credentials stored per organization in an encrypted secrets service; credentials never enter browser state or run payloads.
- PostgreSQL/Supabase as the production system of record. SQLite remains an explicit local-only edition, not an invisible default in a cloud-configured deployment.
- Background job queue with leases, heartbeats, idempotency keys, retries, dead-letter handling, cancellation, and resumable checkpoints.

### Execution plane

- One isolated workspace per run, created from a registered project and pinned commit.
- Policy engine computes capabilities from organization, project, environment, agent role, and approval state.
- Orchestrator creates a typed task graph and assigns specialized agents.
- All effects flow through versioned tools with schemas, idempotency behavior, risk classification, and evidence contracts.
- Verifier uses independent context and deterministic checks where possible. A run cannot self-certify success.
- Every mutation produces a diff, artifact, rollback strategy, provenance record, and human-readable delivery summary.

### Intelligence plane

- Repository index combining AST/symbol graph, dependency graph, semantic chunks, git history, tests, ownership, and operational documentation.
- Temporal project memory with provenance, confidence, validity interval, supersession, contradiction detection, and retention policy.
- Dynamic agent team selected by task type: coordinator, repository analyst, implementer, test engineer, security reviewer, and delivery agent.
- Context compiler selects evidence against a token budget and records why each item was included.
- Model router chooses provider/model by measured task performance, privacy policy, latency, context size, and cost, with local-first and cloud-restricted modes.
- Evaluation service continuously scores planning validity, tool-call validity, change success, verifier precision, cost, latency, and regression rate.

## User Experience Architecture

### Global application shell

- Left navigation: Projects, Runs, Knowledge, Automations, Evaluations, Administration.
- Top bar: active organization, project switcher, environment, command palette, notifications, account menu.
- Never allow an arbitrary filesystem path from the browser. A project must be registered, validated, and authorized before selection.
- Show the authoritative storage mode and sync status under Administration, not as an ambiguous health badge.

### Project overview

The first useful screen after selecting a project shows branch health, recent runs, open approvals, active automations, repository index freshness, and a prominent “New task” command. It does not show provider probes, raw diagnostics, or every installed tool.

### New task flow

1. User enters the desired outcome in a large, focused composer.
2. User selects branch/environment and autonomy mode: Analyze only, Propose changes, Execute with approvals, or Autonomous within policy.
3. An advanced drawer contains provider policy, cost/time budget, model preference, and tool overrides.
4. The system performs a preflight and returns a concise plan, affected areas, risks, required approvals, expected validation, and estimated budget.
5. The user starts the run or edits the plan.

### Active run workspace

- Center: readable activity timeline grouped by phases, with current action and progress.
- Right drawer: context, tool input/output, evidence, diffs, and verifier detail for the selected event.
- Persistent controls: Pause, Stop, Approve, Reject, and Change instructions.
- Failures use plain language, state the blocked policy, and offer valid actions. A policy-invalid planner action is rejected before execution and automatically replanned with the allowed capability set.

### Run result

- Outcome, change summary, files changed, test results, security findings, cost, duration, and confidence.
- Reviewable diff and artifacts.
- Delivery actions such as create branch/commit/PR only when configured and explicitly authorized.
- Full evidence ledger remains available under an Audit tab.

### Administration

Provider configuration, diagnostics, SLOs, tool registry, storage, maintenance, tenant data, and model probes belong here. They must not occupy the normal task workflow.

## Design-System Implementation

1. Keep `tokens.css` as immutable primitive tokens.
2. Add `src/lib/styles/semantic-tokens.css` mapping primitives to roles such as surface, text, border, action, focus, success, warning, and danger for light and dark themes.
3. Add `src/lib/styles/component-tokens.css` for controls, navigation, tables, dialogs, timelines, code viewers, and status indicators.
4. Replace all hardcoded values in route CSS with semantic/component variables except documented one-off data visualizations.
5. Build reusable Svelte components: `AppShell`, `ProjectSwitcher`, `Button`, `IconButton`, `Field`, `Select`, `Tabs`, `Dialog`, `Drawer`, `DataTable`, `StatusBadge`, `EmptyState`, `RunTimeline`, `DiffViewer`, and `Toast`.
6. Use Lucide icons, visible field labels, tooltips for unfamiliar icon actions, consistent focus states, keyboard navigation, WCAG 2.2 AA contrast, and responsive layouts at 360, 768, 1280, and 1600 px.
7. Remove the oversized console title, decorative gradients, excessive all-caps labels, and repeated nested panels. Use a quiet neutral application shell and reserve color for state and action.

Done when a static check rejects raw color literals in component/route CSS, visual regression tests cover every primary state, and usability testing shows users can create a project and start a task without instruction.

## Data Model And Supabase Migration

### Required entities

- `organizations`, `organization_members`, `users`
- `projects`, `project_members`, `repository_connections`, `project_workspaces`
- `environments`, `policy_profiles`, `provider_connections`
- `runs`, `run_attempts`, `run_steps`, `run_events`, `tool_invocations`, `approvals`, `artifacts`
- `knowledge_sources`, `knowledge_documents`, `knowledge_chunks`, `knowledge_edges`
- `memories`, `memory_versions`, `memory_links`
- `automations`, `automation_runs`, `evaluation_suites`, `evaluation_cases`, `evaluation_results`
- `audit_events`, `usage_records`

Every operational row carries `organization_id` and, where applicable, `project_id`. RLS policies derive access from authenticated membership rather than revoking all browser roles and relying on one deployment-wide service tenant.

Current foundation: globally unique token digests resolve to one durable home identity; audited organization memberships attach that account to other tenants with independent roles. V3 sessions sign the immutable home account and selected tenant, exact membership is revalidated on every request, and the top-bar selector performs a server-authorized organization switch. Tenant-owned OIDC connections encrypt their secrets and bind a server-resolved provider revision into signed PKCE state; federated login resolves one unambiguous membership and records the target organization against the home identity. Browser-controlled tenant substitution is rejected by construction. Platform authority is independent of tenant administration. Service-only transactions create an organization with its first administrator and atomically suspend or reactivate admission with lifecycle evidence. Suspension is revalidated across static tokens, durable tokens, existing sessions, and OIDC, while current-session self-lockout is prohibited. Versioned AES-GCM envelopes, optimistic service-role re-encryption, retirement diagnostics, and a dry-run operator command provide managed key rotation without secret disclosure. Per-project memberships, managed invitations/SCIM, hosted Git connections, database JWT/RLS membership policies, and live two-tenant deployment proof remain Phase 1 work and are not claimed complete.

### Migration sequence

1. Add schema versioning and production migrations for organizations and projects.
2. Introduce a `StorageRepository` unit-of-work boundary; remove backend selection conditionals from domain services.
3. Make Supabase/Postgres authoritative in the hosted edition. Use an outbox table for events and asynchronous projections.
4. Add `storage_status` API data: backend, authoritative store, replication mode, last successful write, last failed write, queue depth, and tenant/project IDs in redacted form.
5. Provide a tested SQLite-to-Supabase import command with dry-run, checksums, idempotency, and reconciliation report.
6. Refuse startup when a hosted/production profile has placeholder Supabase configuration or silently falls back to SQLite.

Done when a browser-created project, task, event stream, approval, artifact, and memory are visible in Supabase under the correct organization and project; deleting or changing organization access immediately changes API authorization; reconciliation reports zero divergence.

## Project And Workspace Model

1. Create a project through a controlled flow: local repository registration for desktop/self-hosted use or Git provider installation for hosted use.
2. Validate repository identity, canonical path, remote URL, branch, current commit, cleanliness, size, and supported tooling.
3. Assign a stable `project_id`; never use a display name or filesystem path as identity.
4. Store project-scoped allowed roots, command policy, network policy, provider policy, autonomy limits, and secrets references.
5. Create run workspaces from a pinned commit. Use dedicated git worktrees for local execution and an isolation adapter for hosted workers.
6. Pass an immutable `ExecutionContext` containing organization, project, workspace, commit, actor, policy snapshot, and correlation ID to every agent and tool.
7. Revalidate the context on resume. A run cannot resume against a different project or silently changed policy.

Done when two projects can run concurrently without reading each other’s files, memories, events, settings, credentials, or artifacts, and attempts to substitute a project ID or path fail authorization tests.

## Agent Reliability Upgrades

### Policy-aware planning

- Planner receives a machine-readable capability manifest containing only currently authorized tools and roots.
- Plan schema references tool IDs and validates arguments before admission.
- Invalid path/tool plans never become executable steps.
- Recovery receives structured failure classes and must produce a materially different action; identical retries are prohibited.

### Multi-agent orchestration

- Coordinator owns the task graph and budget but cannot invoke mutation tools.
- Analyst builds repository context and hypotheses.
- Implementer performs scoped edits.
- Test agent derives and executes validation independently.
- Security reviewer inspects changes for policy and vulnerability risk.
- Verifier decides completion from explicit acceptance criteria and evidence.
- Delivery agent packages the result after approval.

Agents communicate through typed work products, not shared free-form chat. Parallel branches use explicit dependencies, leases, merge rules, and conflict handling.

### Verification and recovery

- Convert the user objective into explicit acceptance criteria before execution.
- Prefer deterministic evidence: tests, type checks, AST queries, diff assertions, HTTP probes, screenshots, and database queries.
- Use model verification only for semantic judgments and calibrate it against labeled evaluation cases.
- Classify failures as policy, tool, environment, provider, context, plan, validation, or user-decision failures.
- Recovery actions include argument repair, alternate tool, alternate model, context refresh, rollback, replan, or escalation.

Done when the screenshot’s log-search task succeeds within the configured roots or asks one precise question, never repeats the same invalid root call, and produces direct links to the located logs and relevant errors.

## Differentiated Capabilities

The commercial moat should be an evidence-backed organizational engineering memory rather than “more agents.”

1. **Change intelligence:** connect requests to symbols, dependencies, tests, owners, incidents, previous decisions, and prior failed attempts.
2. **Counterfactual planning:** generate competing approaches, predict blast radius and validation cost, and preserve why one plan won.
3. **Outcome learning:** compare expected and actual effects, update project-specific reliability scores, and avoid strategies that previously failed in the same context.
4. **Policy simulation:** show what an autonomous run could do before granting permissions; explain exactly which policy blocks each effect.
5. **Evidence graph:** make every conclusion traceable to files, commits, tool results, tests, approvals, or external sources with freshness and confidence.
6. **Replayable execution:** reproduce a run from pinned inputs, model/provider versions, policy snapshot, tool versions, and repository commit.
7. **Evaluation flywheel:** automatically convert operator corrections and production failures into private regression cases.

## Delivery Roadmap

### Phase 0: Product reset and measurement (1 week)

- Freeze new dashboard panels and agent features.
- Define three paid workflows: repository change, incident investigation, and dependency/security remediation.
- Instrument task activation, plan approval, execution success, time-to-result, human interventions, rollback, cost, and retention.
- Establish benchmark tasks from real repositories and baseline current success.

Exit gate: 30 representative evaluation tasks, documented personas, measurable success criteria, and a signed information architecture.

### Phase 1: Projects, persistence, and authorization (2-3 weeks)

- Implement organizations, memberships, projects, repository registration, execution context, and project-scoped settings.
- Make Supabase authoritative for hosted mode; add migration/reconciliation tooling.
- Add RLS and API authorization tests for every entity.
- Replace global `process.cwd()` runtime coupling.

Exit gate: two organizations and multiple projects operate concurrently with no cross-tenant or cross-project access; all run data is demonstrably persisted remotely.

### Phase 2: UX and design-system rebuild (2-3 weeks, overlaps Phase 1)

- Implement semantic/component tokens and shared UI primitives.
- Build application shell, project onboarding, task composer, preflight, active run, result, and audit views.
- Move diagnostics and platform configuration into Administration.
- Add responsive, accessibility, and visual regression suites.

Exit gate: five new users complete project onboarding and a successful task without coaching; no critical accessibility defects; approved screenshot baselines at all target viewports.

### Phase 3: Reliable execution kernel (3-4 weeks)

- Add typed execution context, capability compiler, policy-aware planner, argument validation, worker queue, leases, checkpoints, and failure taxonomy.
- Implement independent deterministic verification and rollback-aware mutations.
- Add real-time event delivery with reconnect and replay.

Exit gate: at least 90% success on the benchmark’s supported tasks, zero repeated identical policy-invalid retries, 100% run replay coverage, and forced worker termination resumes without duplicated side effects.

### Phase 4: Project intelligence and memory (4-6 weeks)

- Build repository ingestion, symbol/dependency/test graph, semantic search, git and decision history, provenance, freshness, and contradiction handling.
- Add context compiler and retrieval evaluation.
- Scope every memory and index artifact to organization/project/commit.

Exit gate: retrieval precision and citation correctness meet defined thresholds; stale or contradictory knowledge is visibly marked; benchmark token usage falls without reducing task success.

### Phase 5: Multi-agent teams and model routing (3-5 weeks)

- Introduce role contracts, typed work products, parallel graph scheduling, conflict resolution, and independent verification.
- Add policy-aware model router across cloud and local models.
- Benchmark every provider/model/tool combination instead of inferring readiness from one schema response.

Exit gate: multi-agent mode materially outperforms single-agent mode on complex tasks after accounting for latency and cost; fallback behavior passes outage tests.

### Phase 6: Integrations and automation (4-6 weeks)

- GitHub/GitLab apps, issue trackers, Slack/Teams notifications, CI systems, observability sources, and webhooks.
- Scheduled/event-driven automations with approval policies, deduplication, and concurrency controls.
- Branch, commit, PR, and issue mutation only through explicit scoped integrations.

Exit gate: three complete customer workflows run from trigger to reviewed delivery with auditable external side effects and compensation behavior.

### Phase 7: Enterprise hardening and commercial readiness (continuous; first gate 4 weeks)

- SSO/SAML, SCIM, RBAC, secret rotation, retention, export/deletion, audit export, rate limits, quotas, backup/restore, disaster recovery, and security review.
- OpenTelemetry traces, structured logs, metrics, SLO dashboards, incident runbooks, and capacity tests.
- Licensing, plans, usage metering, onboarding, support workflow, status page, legal policies, and customer-facing security documentation.

Exit gate: threat model reviewed, penetration findings resolved, restore drill passed, load target met, SLOs observed for 30 days, and design partners complete procurement/security review.

## Quality Gates

Every phase must pass:

- Unit, integration, API contract, authorization, migration, and end-to-end tests.
- Fault injection for provider timeout, malformed model output, worker death, event disconnect, database unavailability, duplicate delivery, and partial external failure.
- Real local-model and configured cloud-provider tests; missing credentials produce an explicit skipped result, never a simulated pass.
- Playwright workflow tests and screenshot comparisons on desktop and mobile.
- Security checks for path traversal, command injection, prompt injection, SSRF, secret leakage, tenant substitution, replay, and approval bypass.
- Performance budgets for task start, event latency, index latency, memory retrieval, and UI interaction.
- A release evidence report linking every claim to test output or a measured production signal.

## Commercial Validation

Engineering alone does not establish a USD 1M business. Run a design-partner program in parallel:

- Recruit 5-10 engineering organizations with costly repetitive workflows.
- Measure hours saved, accepted changes, intervention rate, escaped defects, and cost per completed outcome.
- Charge early for one narrow workflow instead of offering a generic agent platform.
- Seek repeat weekly use, expansion to additional projects, and security approval.

The product is commercially credible when at least three customers pay for repeated use, supported tasks exceed the reliability gate, one workflow demonstrates clear ROI, and the platform can onboard and isolate a new organization without custom engineering.

## Immediate Implementation Order

1. Remove diagnostic and administration panels from the primary console.
2. Create the semantic design-token layer and rebuild the application shell.
3. Implement organizations, projects, repository registration, and immutable execution context.
4. Activate and verify Supabase as the authoritative hosted store; ship SQLite migration and reconciliation.
5. Make planning policy-aware and eliminate invalid/repeated tool calls.
6. Build the focused task, run, result, and audit workflows.
7. Establish the real-task evaluation harness before adding advanced memory or more agents.
8. Build the project knowledge/evidence graph, then add specialized multi-agent teams and model routing.

This order fixes trust, usability, and data integrity first. Additional agents are valuable only after the platform can reliably identify the project, persist its state, execute within policy, and explain the outcome to a human.
