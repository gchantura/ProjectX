---
name: manage-project
description: Implement, modify, debug, refactor, or review any codebase task under the repository's canonical AI operating policy. Use for every task that may change source, configuration, dependencies, tests, architecture, integrations, or generated project context.
---

# Manage project

Canonical source: `.ai/skills/manage-project/SKILL.md`. Vendor skill copies are generated and must not be edited directly.

1. Read `.ai/architecture/overview.md` and query `PROJECT_MAP.md` or the project MCP.
2. Use `get_applicable_policies` and read only the returned policy files.
3. Assess the request with `assess_complexity`; apply the returned process level.
4. Inspect only relevant source and tests. Prefer existing patterns and the smallest complete change.
5. For structural changes, write a plan. For critical changes, document impact and rollback strategy and perform enhanced validation.
6. Implement and verify behavior. Add an ADR only for durable architectural decisions.
7. Remove temporary verification artifacts. Run `npm run ai:sync`, `npm run ai:check`, and task-relevant quality commands.
8. Report scope, evidence, failures, and remaining risk.

Never duplicate generated repository facts in policy documents. Never weaken checks merely to make them pass.
