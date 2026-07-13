# Operator workflow

This guide describes normal operation of KcevAgent. Production configuration and service management are covered in [PRODUCTION.md](PRODUCTION.md).

## 1. Start from a ready environment

Open **Operations** and confirm that storage, identity, memory, security, provider, lease, approval, and event-replay checks are acceptable. Sign in with your personal KcevAgent access token, which selects its organization automatically, or enter the organization slug from your invitation and continue with company SSO. The browser receives a signed eight-hour Secure, HttpOnly, SameSite=Strict session; access tokens and provider keys never enter browser storage.

The console shows exact failures and remediation actions. Do not start a run by bypassing a blocked readiness or governance check.

## 2. Select and probe a provider/model pair

Choose a provider and model in the task runner. Cloud model choices are configured on the server. Ollama choices are discovered from the live local runtime.

Select **Test connection** after changing models. Readiness evidence belongs to that exact provider/model pair: probing one Ollama or cloud model does not authorize another. A successful live structured-output probe is required before governance admits a run.

For cloud execution, configure current input and output rates on the server when using a positive cost ceiling. Admission fails closed if the ceiling cannot be calculated for the selected provider.

## 3. Define a bounded objective

Write a concrete objective with expected evidence and scope. Select the coding module, step ceiling, provider, and model. Global token, cost, path, and network controls come from **Settings**.

The coding module can inspect and search the workspace, analyze change impact, write sandboxed artifacts, make approval-gated source changes, and run allowlisted validation. It cannot execute arbitrary shell commands or write outside configured roots.

## 4. Run and inspect the agent loop

Select **Review plan**. Inspect the exact steps, tools, risks, commit, policy, and plan fingerprint. Select **Approve and execute** only when that persisted plan is acceptable. The one-time approval is consumed atomically before the NDJSON stream begins, then:

1. Planner candidates produce dependency-valid task graphs.
2. The adjudicator selects a plan when multi-hypothesis planning is enabled.
3. The Executor performs one code-enforced tool step at a time.
4. The independent Verifier requires positive raw evidence before accepting each step.
5. The Orchestrator enforces dependencies, retries, ceilings, budgets, rollback, and escalation.

Use the center timeline to follow state changes. Select a step to inspect its exact tool call, raw output, verifier reason, and evidence. Failures remain visible and are never converted into successful states merely because a tool returned without throwing.

## 5. Stop, recover, and resume

**Stop run** aborts active provider work and persists the completed prefix plus remaining steps. **Resume run** starts from the first non-verified step.

Resume repeats security, storage, provider/model, governance, and pricing admission. Model-backed runs reuse their persisted adapter and independent verifier. A changed or unavailable provider fails visibly without altering the existing evidence ledger.

Validation failure after a source edit triggers checkpoint recovery when available. A step is retried at most once; repeated verification failure escalates to the operator.

## 6. Approve source writes deliberately

High-risk source writes require the exact approval phrase shown in the console, a target path, content, and reason. Approval is bound to that path and request. Writes outside configured source roots or attempts with a different path are rejected.

Review the impact analysis and current file evidence before approving. Use the normal agent edit flow for evidence-based exact replacements; use the approval queue only when a deliberate operator-authored write is appropriate.

## 7. Manage durable memory

The memory panel stores bounded workspace facts, preferences, and constraints. Secret-like content is rejected. Verified runs may record deduplicated outcome memory automatically; failed or stopped runs do not become success memory.

Use **Forget** to remove obsolete context. Add expiry dates through the API for temporary memory. Memory is tenant-scoped when Supabase is enabled.

Your personal access token is already bound to one organization. Sign in with the token exactly as issued; KcevAgent resolves the organization on the server and shows its name beside your role. Never enter a Supabase tenant UUID, OpenAI key, database password, or computer password on the sign-in screen.

Platform administrators can open **Administration > Organization provisioning**, enter the organization name and slug plus the first administrator's ID and display name, and choose **Create organization**. The returned token signs that administrator directly into the new organization. Copy it once and transfer it through an approved secret channel; it is not recoverable after the page reloads. Use **Suspend** to stop every token, session, and company SSO login for another organization immediately; use **Reactivate** to restore its still-active identities. The current organization cannot be suspended from its own session. Tenant administrators can manage identities only inside their own organization and cannot create or suspend organizations.

For multi-organization access, copy the account reference under **Organization memberships** and give it to an administrator in the destination organization. That administrator assigns a role without creating another password or token. The organization selector in the top bar switches only among active memberships. Removing an external membership leaves the account and its other organizations intact; revoking the home identity removes access everywhere.

An organization administrator configures company sign-in under **Administration > Company SSO**. Copy the displayed callback URL into the identity-provider application, then enter the issuer URL, client ID, client secret, scopes, and any additional trusted endpoint origins. **Validate and connect SSO** performs live provider discovery before encrypting the secret. The secret field is deliberately blank after every save because KcevAgent never returns stored secrets. Saving again rotates the credential and invalidates any sign-in already in progress. **Disable company SSO** blocks new SSO attempts while personal access tokens continue to work.

## 8. Review and export evidence

Open a run ledger from history to inspect normalized steps, tool calls, verification decisions, artifacts, events, and task-graph state. Use `/api/runs/:id/export` for a portable JSON audit bundle.

The bundle includes deterministic component hashes and a bundle SHA-256 digest. Preserve it with incident or change records when external review is required.

## 9. Operate and monitor

Use these surfaces during normal operation:

- `/api/diagnostics` — redacted storage, security, provider, model, and replay checks.
- `/api/governance` — run admission decision and exact remediation actions.
- `/api/operations/slo` — success, attention, readiness, latency, token, and estimated-cost SLOs.
- `/api/metrics` — authenticated Prometheus metrics in production.
- `/api/automation/maintenance` — idempotent diagnostics and stale-probe refresh for an external scheduler.

Alert on readiness failures, provider errors, verifier rejections, exhausted retries, needs-attention runs, latency, budget stops, and missing event replay. Never place provider keys, operator credentials, task contents, or raw tool output into metric labels.

## 10. Verify repository changes

After changing KcevAgent itself, run:

```powershell
npm run ai:sync
npm run ai:check
npm run ai:test
npm run build
```

UI changes also require a live browser check. Do not deploy when generated policy artifacts are stale, tests fail, the production build fails, or readiness reports a blocking security or storage condition.
