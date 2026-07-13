<script>
	const { data } = $props();
	let token = $state('');
	let errorMessage = $state('');
	let isSubmitting = $state(false);
	async function signIn(event) {
		event.preventDefault();
		if (!token) return;
		isSubmitting = true; errorMessage = '';
		try {
			const response = await fetch('/api/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload.error || 'Authentication failed.');
			const returnTo = new URLSearchParams(window.location.search).get('returnTo');
			window.location.assign(returnTo?.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
		} catch (error) { errorMessage = error.message; } finally { isSubmitting = false; }
	}
</script>

<svelte:head><title>Sign in / KcevAgent</title><meta name="description" content="Sign in to your KcevAgent organization." /></svelte:head>

<main class="auth-shell">
	<section class="auth-workspace" aria-labelledby="auth-title">
		<header class="auth-brand"><span class="brand-mark">K</span><strong>KcevAgent</strong><small>Governed agent operations</small></header>
		<div class="auth-primary">
			<div><p class="eyebrow">Secure workspace</p><h1 id="auth-title">Sign in to KcevAgent</h1><p>{data?.access?.message ?? ''}</p></div>
			{#if data?.ssoError}<p class="error-message" role="alert">{data.ssoError}</p>{/if}
			{#if data?.oidc?.enabled}
				<form class="sso-form" method="GET" action="/api/auth/oidc/start">
					<label for="organization-slug">Organization slug</label>
					<input id="organization-slug" name="organization" value={data?.organization ?? ''} required minlength="3" maxlength="64" pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" aria-describedby="organization-help" placeholder="northwind-engineering" autocomplete="organization" />
					<input type="hidden" name="returnTo" value={data?.returnTo ?? ''} />
					<p id="organization-help" class="field-help">Use the slug in your KcevAgent invitation. This selects your company workspace before {data?.oidc?.displayName ?? 'Company SSO'} verifies your account.</p>
					<button class="auth-sso auth-sso--primary" type="submit">Continue with {data?.oidc?.displayName ?? 'SSO'}</button>
				</form>
			{/if}
			{#if data?.oidc?.enabled && data?.access?.tokenEnabled}<div class="auth-divider"><span>or use a token</span></div>{/if}
			{#if data?.access?.tokenEnabled}
				<form onsubmit={signIn}>
					<label for="operator-token">Personal access token</label>
					<input id="operator-token" type="password" bind:value={token} autocomplete="current-password" required minlength="32" aria-describedby="token-help" placeholder="Paste the token issued to you" />
					<p id="token-help" class="field-help">This is not your OpenAI API key or computer password. It comes from your KcevAgent administrator{data?.access?.source === 'deployment' ? ' or deployment secret manager during first setup' : ''}.</p>
					<button class="button button--primary" type="submit" disabled={isSubmitting || token.length < 32}>{isSubmitting ? 'Signing in...' : 'Sign in with token'}</button>
					{#if errorMessage}<p class="error-message" role="alert">{errorMessage}</p>{/if}
				</form>
			{/if}
			{#if data?.access?.setupRequired}<div class="auth-unavailable" role="status"><strong>Server setup required</strong><p>A deployment administrator must configure company SSO or create the initial server credentials before anyone can sign in.</p><code>npm run auth:operator</code><small>Run this in the deployment workspace, configure the generated secrets, and restart the service.</small></div>{/if}
			<footer><span>Tokens are exchanged for signed, Secure, HttpOnly sessions and are never stored in browser JavaScript.</span></footer>
		</div>
		<aside class="auth-guidance" aria-labelledby="access-help-title">
			<p class="eyebrow">Access guide</p><h2 id="access-help-title">Where does my access come from?</h2>
			<ol><li><strong>Company account</strong><span>Enter the organization slug from your invitation, then use your normal company identity.</span></li><li><strong>Personal token</strong><span>An organization administrator issues this from Administration. It is shown once and selects your organization and assigned role automatically.</span></li><li><strong>First deployment only</strong><span>The person deploying KcevAgent retrieves <code>KCEV_OPERATOR_TOKEN</code> from the server secret manager. Remove it after named administrators are active.</span></li></ol>
			<div class="auth-security"><strong>Never enter</strong><span>An AI-provider API key, computer password, or database password on this page.</span></div>
		</aside>
	</section>
</main>
