# Universal agent workflow

1. Read the nearest generated vendor adapter, then `.ai/architecture/overview.md`.
2. Query the project map or MCP before opening source files. Load only task-relevant files.
3. Select applicable policies with MCP `get_applicable_policies` or the routing table below.
4. Assess complexity with the canonical rubric before editing.
5. For levels 0–1, implement directly with proportionate checks. For level 2, record a short plan and impact analysis. For level 3, record a plan, impact analysis, rollback strategy, and enhanced validation before proceeding autonomously.
6. Preserve existing architecture unless the request requires changing it. Record durable architectural decisions as ADRs.
7. Run `npm run ai:sync`, `npm run ai:check`, and request-relevant tests before declaring completion.
8. Remove temporary verification artifacts, then report changed files, behavioral impact, and evidence. Never hide failed checks.

Do not add abstractions, dependencies, compatibility layers, or new files without a concrete need. Prefer the smallest complete change.

## Policy routing

Always load: `complexity.md`, `quality.md`, `security.md`, `design.md`, and `hygiene.md`.

- Bugs, failures, diagnostics, or error messages: load `debugging.md`.
- Database, schema, SQL, migrations, storage, or RLS: load `database.md`.
- Pages, components, forms, styles, layouts, or visual work: load `ui.md`.
- Svelte/SvelteKit files or requests: load `frameworks/sveltekit.md`.
