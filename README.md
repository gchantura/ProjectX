# KcevAgent

KcevAgent is a production-oriented agent operations platform with separate planner, executor, verifier, and adjudicator roles; code-enforced tools; persistent run ledgers; scoped memory; real OpenAI, Claude, Gemini, Grok, and Ollama provider adapters; streaming operator traces; authentication; health checks; metrics; and deployment-ready Node operations.

For deployment and operations, see [`docs/PRODUCTION.md`](docs/PRODUCTION.md). Copy `.env.example` to `.env`, configure server-only credentials, run the quality gates, and start the built Node server behind your preferred process manager or platform runtime.

This project includes a framework-neutral AI operating layer. Canonical policy, architecture intent, skills, and integrations live under `.ai/`; project facts and vendor-specific adapters are generated.

It is compatible with multiple AI agents when their host supports repository instruction loading, MCP, or manual context attachment. It does not make raw models discover or obey project instructions automatically. The generated project map is a navigation aid, not full semantic code intelligence, and reduced token usage is a design goal rather than a guarantee.

## Development

```sh
npm install
npm run dev
```

## Quality gates

```sh
npm run ai:sync
npm run ai:check
npm run ai:test
npm run build
```

Start with `.ai/manifest.yaml`. `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `PROJECT_MAP.md`, skill adapters, and `.mcp.json` are derived artifacts. See `docs/MCP_CLIENT_SETUP.md` for host integration.

Daily operator workflow is documented in [`docs/USER_WORKFLOW.md`](docs/USER_WORKFLOW.md).

To publish your library to [npm](https://www.npmjs.com):

```sh
npm publish
```
