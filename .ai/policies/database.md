# Database and schema policy

Before writing SQL:

1. Inspect the existing schema, migrations, naming conventions, extensions, and access model.
2. Propose the schema first.
3. Explain required tables, relationships, indexes, constraints, and RLS policies.
4. Obtain the approval required by the task's complexity level, then write SQL.

Implementation rules:

- Use UUID primary keys unless the project already uses another standard.
- Add `created_at` and `updated_at` where lifecycle tracking is useful.
- Enforce relationships with foreign keys and deliberate delete/update behavior.
- Index foreign keys and frequently filtered, joined, sorted, or uniqueness-constrained columns.
- Do not create duplicate or overlapping tables. Extend existing structures when appropriate.
- Use migrations; do not mutate production schema ad hoc.
- Design RLS for least privilege and test both allowed and denied access paths.
