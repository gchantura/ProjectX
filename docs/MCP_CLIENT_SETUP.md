# MCP client setup

MCP connects to an LLM through a host application; a raw model server such as Ollama is not itself an MCP client. Use an MCP-capable host (for example Claude Code, VS Code/Copilot, Codex, Cline, Continue, or an Open WebUI bridge) and translate the generated `.mcp.json` to that host's configuration shape.

The canonical registry is `.ai/integrations/mcp.yaml`. Never edit `.mcp.json` directly. Add a reviewed registry entry, set `enabled`, record its trust/provider, and run `npm run ai:sync`.

## Servers

- `project`: local, deterministic, and live. Run `node tools/project-mcp.mjs` over stdio.
- `svelte`: official Svelte documentation/autofix server. Run `npx -y @sveltejs/mcp`.
- `tailwind`: optional community server. Run `npx -y tailwindcss-mcp-server`; review and pin the package before sensitive use because it is not maintained by Tailwind Labs.

Commands must run with this repository as their working directory. Prefer absolute paths in clients that do not preserve workspace CWD.

## Adding another MCP

1. Prefer an official, locally scoped server and inspect its permissions.
2. Add a uniquely named entry to `.ai/integrations/mcp.yaml`; pin versions for reproducibility.
3. Keep credentials in the host's secret/environment store, never in this repository.
4. Record trust, provider, purpose, write permissions, and required environment variables.
5. Run `npm run ai:sync` and `npm run ai:check`.
