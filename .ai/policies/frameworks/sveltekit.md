# Svelte and SvelteKit policy

Apply these rules only when working with Svelte or SvelteKit:

- Use `+page.svelte` for page UI and `+page.server.ts` for server-only page data and actions.
- Use `+layout.svelte` for shared layout UI. Use `+layout.server.ts` only when server data is needed globally.
- Use `hooks.server.ts` for authentication or session handling when required.
- Keep secrets and private environment variables out of browser code.
- Use `$env/static/private` for private server values and `$env/static/public` only for values safe to expose.
- Prefer SvelteKit form actions where they fit the interaction.
- Protect private routes with server-side authorization and redirects; client guards are not security boundaries.
- Keep load functions typed.
- Keep components small, focused, and reusable without fragmenting trivial markup.
- Follow the project's installed Svelte version and conventions; for Svelte 5, prefer runes unless existing scoped code deliberately uses legacy mode.
