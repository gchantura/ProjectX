# Architecture intent

This repository uses a framework-neutral AI operating layer. `.ai/manifest.yaml` is the canonical machine configuration. Code and package metadata are authoritative for facts that can be derived automatically; this document records only intent and boundaries.

Compatibility requires an agent host that loads repository instructions or manually attaches them. Raw models do not discover this layer automatically. The generated map is a token-efficient navigation index, not complete semantic or architectural understanding.

## Boundaries

- Product code must not depend on the AI operating layer.
- `tools/ai-system` may inspect the repository and update derived files, but must not edit product code.
- `.ai/architecture/map.json`, `PROJECT_MAP.md`, and vendor instruction files are generated outputs.
- Framework MCP servers are optional plugins. The project MCP remains usable without them.
- `.ai/integrations/mcp.yaml` is the reviewed MCP registry; `.mcp.json` is generated from enabled entries.
- Secrets, environment values, personal data, and source-file bodies must never be copied into generated indexes.

## Source-specific intent

- `src/routes` currently owns the SvelteKit showcase application.
- `src/lib` currently owns the package's public library API.
- These are current project facts, not assumptions built into the AI system.
