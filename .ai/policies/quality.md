# Quality gates

A task is complete only when:

- generated AI artifacts are synchronized;
- repository structure and adapter validation pass;
- relevant type, lint, test, and build checks pass or failures are disclosed;
- changed behavior is covered by an existing or new verification path;
- architectural changes have an ADR;
- no unrelated files or dependencies were introduced.

Generated context is an index, not a substitute for source code or tests.
