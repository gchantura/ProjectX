# Complexity policy

Use `npm run ai:assess -- --request "..." --files path1,path2` or the MCP `assess_complexity` tool. Never lower the returned level without explaining which detected risk is false.

- Level 0 — trivial: isolated text/style/config value; no behavior or boundary change.
- Level 1 — local: small behavioral change inside an established pattern.
- Level 2 — structural: shared API, dependency, route, schema, integration, or cross-boundary change. Produce a plan and impact analysis first.
- Level 3 — critical: authentication, authorization, secrets, payments, destructive operations, migrations, deployment/security policy, or broad refactor. Proceed autonomously after documenting a plan, impact analysis, rollback strategy, and enhanced validation scope.

When uncertain, choose the higher level. Complexity controls process depth, not code quantity alone.
