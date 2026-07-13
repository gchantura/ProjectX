<script>
	const { active = '', context = '', identity, children } = $props();
	let switchStatus = $state('');
	let isSwitching = $state(false);
	async function signOut() { await fetch('/api/auth/session', { method: 'DELETE' }); location.assign('/login'); }
	async function switchOrganization(event) {
		const tenantId = event.currentTarget.value;
		if (!tenantId || tenantId === identity?.tenantId) return;
		isSwitching = true;
		switchStatus = '';
		const response = await fetch('/api/auth/organization', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId }) });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) { switchStatus = payload.error || 'Unable to switch organization.'; isSwitching = false; return; }
		location.reload();
	}
</script>

<div class="workspace-shell">
	<aside class="workspace-nav">
		<a class="brand" href="/" aria-label="KcevAgent home"><span class="brand-mark">K</span><span>KcevAgent</span></a>
		<nav aria-label="Primary navigation">
			<a class:nav-item--active={active === 'projects'} class="nav-item" href="/"><span class="nav-full">Projects</span><span class="nav-short">Projects</span></a>
			<a class:nav-item--active={active === 'runs'} class="nav-item" href="/runs"><span class="nav-full">Runs</span><span class="nav-short">Runs</span></a>
			<a class:nav-item--active={active === 'operations'} class="nav-item" href="/operations"><span class="nav-full">Operations</span><span class="nav-short">Ops</span></a>
			<a class:nav-item--active={active === 'capabilities'} class="nav-item" href="/modules"><span class="nav-full">Capabilities</span><span class="nav-short">Tools</span></a>
			{#if identity?.role === 'admin'}<a class:nav-item--active={active === 'administration'} class="nav-item" href="/settings"><span class="nav-full">Administration</span><span class="nav-short">Admin</span></a>{/if}
		</nav>
		<div class="nav-footer"><span class="storage-dot" data-ready="true"></span><div><strong>supabase-postgres</strong><small>Authoritative store</small></div></div>
	</aside>
	<div class="workspace-body">
		<header class="workspace-topbar">
			<div class="project-control"><span>Workspace</span><strong>{context}</strong></div>
			<div class="topbar-actions">
				{#if identity?.memberships?.length}
					<label class="organization-switcher"><span>Organization</span><select aria-label="Active organization" value={identity.tenantId} onchange={switchOrganization} disabled={isSwitching || identity.memberships.length < 2}>{#each identity.memberships as membership}<option value={membership.tenantId} disabled={membership.status !== 'active' || membership.tenantStatus !== 'active'}>{membership.tenantName} / {membership.role}</option>{/each}</select></label>
				{/if}
				<span class="identity-label"><strong>{identity?.name}</strong><small>{identity?.role}</small></span>{#if identity?.role === 'admin' && active !== 'administration'}<a href="/settings">Settings</a>{/if}<button class="quiet-button" type="button" onclick={signOut}>Sign out</button>
				{#if switchStatus}<small class="organization-switch-error" role="status">{switchStatus}</small>{/if}
			</div>
		</header>
		<div class="app-content">{@render children()}</div>
	</div>
</div>
