# ADR 0001: Canonical AI operating layer

Status: accepted

## Decision

Store vendor-neutral policy, architecture intent, skills, and generated context under `.ai/`. Generate concise adapters for tools that expect `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or Copilot instructions.

Do not manually duplicate repository facts across vendor files. Derive file structure, imports, exports, package metadata, and change fingerprints from source.

## Consequences

- One policy change can update all supported agents.
- Agents that cannot read repository files or call MCP still require their host to attach the generated adapter.
- Generated artifacts must be checked for staleness in CI or before task completion.
