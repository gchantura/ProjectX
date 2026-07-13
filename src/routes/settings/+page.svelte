<script>
	import AppShell from '$lib/components/AppShell.svelte';
	const { data } = $props();

	let settings = $state({});
	let saveStatus = $state('');
	let isSaving = $state(false);
	let selectedProjectId = $state('');
	let identities = $state(readInitial(() => data.identities, []));
	let identityId = $state('');
	let identityName = $state('');
	let identityRole = $state('operator');
	let issuedToken = $state('');
	let identityStatus = $state(readInitial(() => data.identityError, ''));
	let isIssuingIdentity = $state(false);
	let memberships = $state(readInitial(() => data.memberships, []));
	let membershipAccountReference = $state('');
	let membershipRole = $state('operator');
	let membershipStatus = $state('');
	let isSavingMembership = $state(false);
	let organizations = $state(readInitial(() => data.organizations, []));
	let organizationName = $state('');
	let organizationSlug = $state('');
	let organizationAdminId = $state('');
	let organizationAdminName = $state('');
	let organizationToken = $state('');
	let organizationStatus = $state(readInitial(() => data.organizationError, ''));
	let isProvisioningOrganization = $state(false);
	let ssoConnection = $state(readInitial(() => data.ssoConnection, null));
	let ssoDisplayName = $state(readInitial(() => data.ssoConnection?.displayName, 'Company SSO'));
	let ssoIssuer = $state(readInitial(() => data.ssoConnection?.issuer, ''));
	let ssoClientId = $state(readInitial(() => data.ssoConnection?.clientId, ''));
	let ssoClientSecret = $state('');
	let ssoScopes = $state(readInitial(() => data.ssoConnection?.scopes, 'openid profile email'));
	let ssoAllowedOrigins = $state(readInitial(() => data.ssoConnection?.allowedEndpointOrigins, []).join('\n'));
	let ssoStatus = $state(readInitial(() => data.ssoError, ''));
	let isSavingSso = $state(false);
	let invitations = $state(readInitial(() => data.invitations, []));
	let invitationEmail = $state('');
	let invitationRole = $state('operator');
	let invitationDays = $state(7);
	let invitationStatus = $state(readInitial(() => data.lifecycleError, ''));
	let isInviting = $state(false);
	let scimConnection = $state(readInitial(() => data.scimConnection, null));
	let scimDisplayName = $state(readInitial(() => data.scimConnection?.displayName, 'Directory provisioning'));
	let scimToken = $state('');
	let scimStatus = $state('');
	let isSavingScim = $state(false);

	$effect(() => {
		if (!selectedProjectId) selectedProjectId = data.selectedProjectId;
		if (!settings.provider) settings = { ...data.settings };
	});

	async function changeProject() {
		saveStatus = '';
		const response = await fetch(`/api/settings?projectId=${encodeURIComponent(selectedProjectId)}`);
		const payload = await response.json();
		if (!response.ok) { saveStatus = payload.error || 'Unable to load project settings.'; return; }
		settings = payload.settings;
		history.replaceState(null, '', `/settings?projectId=${encodeURIComponent(selectedProjectId)}`);
	}

	async function saveSettings() {
		isSaving = true;
		saveStatus = '';

		try {
			const response = await fetch('/api/settings', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...settings, projectId: selectedProjectId })
			});

			if (!response.ok) {
				const message = await response.text();
				throw new Error(message || 'Unable to save settings.');
			}

			const payload = await response.json();
			settings = payload.settings;
			saveStatus = 'Settings saved';
		} catch (error) {
			saveStatus = error.message;
		} finally {
			isSaving = false;
		}
	}

	async function issueIdentity(event) {
		event.preventDefault();
		isIssuingIdentity = true;
		identityStatus = '';
		issuedToken = '';
		try {
			const response = await fetch('/api/admin/identities', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: identityId, displayName: identityName, role: identityRole }) });
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload.error || 'Unable to issue identity.');
			identities = [payload.identity, ...identities.filter((identity) => identity.id !== payload.identity.id)];
			issuedToken = payload.token;
			identityStatus = 'Access issued. Store the token now; it will not be shown again.';
			identityId = '';
			identityName = '';
		} catch (error) { identityStatus = error.message; }
		finally { isIssuingIdentity = false; }
	}

	async function revokeIdentity(identity) {
		if (!confirm(`Revoke access for ${identity.displayName}?`)) return;
		const response = await fetch(`/api/admin/identities/${encodeURIComponent(identity.id)}`, { method: 'DELETE' });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) { identityStatus = payload.error || 'Unable to revoke identity.'; return; }
		identities = identities.map((item) => item.id === identity.id ? { ...item, status: 'revoked', revokedAt: payload.revokedAt } : item);
		identityStatus = `${identity.displayName} was revoked.`;
	}

	async function copyIssuedToken() {
		await navigator.clipboard.writeText(issuedToken);
		identityStatus = 'Token copied. It remains visible only until this page reloads.';
	}

	async function copyAccountReference() {
		if (!data.identity.accountReference) return;
		await navigator.clipboard.writeText(data.identity.accountReference);
		membershipStatus = 'Account reference copied.';
	}

	async function grantMembership(event) {
		event.preventDefault();
		const separator = membershipAccountReference.indexOf(':');
		if (separator < 1) { membershipStatus = 'Enter an account reference in organization-id:identity-id format.'; return; }
		isSavingMembership = true;
		membershipStatus = '';
		const response = await fetch('/api/admin/memberships', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountTenantId: membershipAccountReference.slice(0, separator), identityId: membershipAccountReference.slice(separator + 1), role: membershipRole }) });
		const payload = await response.json().catch(() => ({}));
		if (response.ok) {
			memberships = [payload.membership, ...memberships.filter((item) => !(item.accountTenantId === payload.membership.accountTenantId && item.identityId === payload.membership.identityId))];
			membershipAccountReference = '';
			membershipStatus = `${payload.membership.displayName} now has ${payload.membership.role} access.`;
		} else membershipStatus = payload.error || 'Unable to grant organization access.';
		isSavingMembership = false;
	}

	async function revokeMembership(membership) {
		if (!confirm(`Remove ${membership.displayName} from this organization?`)) return;
		const response = await fetch(`/api/admin/memberships/${encodeURIComponent(membership.accountTenantId)}/${encodeURIComponent(membership.identityId)}`, { method: 'DELETE' });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) { membershipStatus = payload.error || 'Unable to revoke organization access.'; return; }
		memberships = memberships.map((item) => item.accountTenantId === membership.accountTenantId && item.identityId === membership.identityId ? { ...item, status: 'revoked', revokedAt: payload.revokedAt } : item);
		membershipStatus = `${membership.displayName} no longer has access to this organization.`;
	}

	async function provisionOrganization(event) {
		event.preventDefault();
		isProvisioningOrganization = true;
		organizationStatus = '';
		organizationToken = '';
		try {
			const response = await fetch('/api/platform/organizations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: organizationName, slug: organizationSlug, adminId: organizationAdminId, adminDisplayName: organizationAdminName }) });
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload.error || 'Unable to create organization.');
			organizations = [payload.organization, ...organizations];
			organizationToken = payload.token;
			organizationStatus = `${payload.organization.name} is active. Its first administrator can sign in with the token below.`;
			organizationName = '';
			organizationSlug = '';
			organizationAdminId = '';
			organizationAdminName = '';
		} catch (error) { organizationStatus = error.message; }
		finally { isProvisioningOrganization = false; }
	}

	async function copyOrganizationToken() {
		await navigator.clipboard.writeText(organizationToken);
		organizationStatus = 'Initial administrator token copied. It remains visible only until this page reloads.';
	}

	async function changeOrganizationStatus(organization) {
		const status = organization.status === 'active' ? 'suspended' : 'active';
		const action = status === 'suspended' ? 'Suspend' : 'Reactivate';
		if (!confirm(`${action} ${organization.name}? ${status === 'suspended' ? 'All token, session, and company SSO access will stop immediately.' : 'Its active identities will be able to sign in again.'}`)) return;
		organizationStatus = '';
		const response = await fetch(`/api/platform/organizations/${encodeURIComponent(organization.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) { organizationStatus = payload.error || 'Unable to change organization status.'; return; }
		organizations = organizations.map((item) => item.id === organization.id ? payload.organization : item);
		organizationStatus = `${payload.organization.name} is now ${payload.organization.status}.`;
	}

	async function saveSso(event) {
		event.preventDefault();
		isSavingSso = true;
		ssoStatus = 'Validating identity-provider discovery...';
		try {
			const response = await fetch('/api/admin/sso', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: ssoDisplayName, issuer: ssoIssuer, clientId: ssoClientId, clientSecret: ssoClientSecret, scopes: ssoScopes, allowedEndpointOrigins: ssoAllowedOrigins }) });
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload.error || 'Unable to configure company SSO.');
			ssoConnection = payload.connection;
			ssoClientSecret = '';
			ssoStatus = 'Company SSO is active. The client secret was encrypted and will not be shown again.';
		} catch (error) { ssoStatus = error.message; }
		finally { isSavingSso = false; }
	}

	async function changeSsoStatus() {
		const status = ssoConnection.status === 'active' ? 'disabled' : 'active';
		if (status === 'disabled' && !confirm('Disable company SSO for this organization? Personal access tokens will continue to work.')) return;
		const response = await fetch('/api/admin/sso', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) { ssoStatus = payload.error || 'Unable to change company SSO status.'; return; }
		ssoConnection = payload.connection;
		ssoStatus = `Company SSO is now ${payload.connection.status}.`;
	}

	async function copySsoCallback() {
		await navigator.clipboard.writeText(data.oidcCallbackUrl);
		ssoStatus = 'Callback URL copied.';
	}

	async function createInvitation(event) {
		event.preventDefault();
		isInviting = true;
		invitationStatus = '';
		const response = await fetch('/api/admin/invitations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: invitationEmail, role: invitationRole, expiresInDays: Number(invitationDays) }) });
		const payload = await response.json().catch(() => ({}));
		if (response.ok) {
			invitations = [payload.invitation, ...invitations.map((item) => item.email === payload.invitation.email && item.status === 'pending' ? { ...item, status: 'revoked' } : item)];
			invitationStatus = `${payload.invitation.email} can now join with company SSO.`;
			invitationEmail = '';
		} else invitationStatus = payload.error || 'Unable to create invitation.';
		isInviting = false;
	}

	async function revokeInvitation(invitation) {
		if (!confirm(`Revoke the invitation for ${invitation.email}?`)) return;
		const response = await fetch(`/api/admin/invitations/${encodeURIComponent(invitation.id)}`, { method: 'DELETE' });
		const payload = await response.json().catch(() => ({}));
		if (response.ok) {
			invitations = invitations.map((item) => item.id === invitation.id ? { ...item, status: 'revoked', revokedAt: payload.revokedAt } : item);
			invitationStatus = `Invitation for ${invitation.email} was revoked.`;
		} else invitationStatus = payload.error || 'Unable to revoke invitation.';
	}

	async function configureScim(event) {
		event.preventDefault();
		isSavingScim = true;
		scimStatus = '';
		scimToken = '';
		const response = await fetch('/api/admin/scim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: scimDisplayName }) });
		const payload = await response.json().catch(() => ({}));
		if (response.ok) {
			scimConnection = payload.connection;
			scimToken = payload.token;
			scimStatus = 'SCIM bearer token rotated. Update the identity provider before leaving this page.';
		} else scimStatus = payload.error || 'Unable to configure SCIM.';
		isSavingScim = false;
	}

	async function changeScimStatus() {
		const status = scimConnection?.status === 'active' ? 'disabled' : 'active';
		const response = await fetch('/api/admin/scim', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
		const payload = await response.json().catch(() => ({}));
		if (response.ok) {
			scimConnection = { ...scimConnection, status };
			scimStatus = `SCIM provisioning ${status === 'active' ? 'enabled' : 'disabled'}.`;
		} else scimStatus = payload.error || 'Unable to change SCIM status.';
	}

	async function copyScimValue(value, message) {
		await navigator.clipboard.writeText(value);
		scimStatus = message;
	}

	function readInitial(read, fallback) { return read() ?? fallback; }
</script>

<svelte:head>
	<title>Settings / KcevAgent</title>
	<meta name="description" content="Configure KcevAgent runtime guardrails." />
</svelte:head>

<AppShell active="administration" context="Administration" identity={data.identity}>
<main class="admin-page settings-shell-new">
	<header class="page-heading" aria-labelledby="settings-title"><div><p class="section-kicker">Administration</p><h1 id="settings-title">Policy and access</h1><p>Configure project execution limits, provider defaults, and tenant identities from one governed control plane.</p></div><div class="heading-control"><label for="settings-project">Project policy</label><select id="settings-project" bind:value={selectedProjectId} onchange={changeProject}>{#each data.projects as project}<option value={project.id}>{project.name}</option>{/each}</select></div></header>

	<section class="settings-grid" aria-label="Agent settings">
		<form class="panel settings-form" onsubmit={(event) => event.preventDefault()}>
			<div class="panel__header">
				<h2>Runtime defaults</h2>
				<span class="mini-badge">server saved</span>
			</div>

			<div class="field-row">
				<label for="provider">Provider</label>
				<select id="provider" bind:value={settings.provider}>
					{#each data.providers as provider}
						<option value={provider.id}>{provider.name}</option>
					{/each}
				</select>
			</div>

			<div class="field-row">
				<label for="model">Model</label>
				<input id="model" bind:value={settings.model} />
			</div>

			<div class="field-row">
				<label for="domain">Default module</label>
				<input id="domain" bind:value={settings.domain} />
			</div>

			<div class="field-row">
				<label for="steps">Step ceiling</label>
				<input id="steps" type="number" min="1" max="12" bind:value={settings.stepCeiling} />
			</div>

			<div class="field-row">
				<label for="planning-mode">Planning mode</label>
				<select id="planning-mode" bind:value={settings.planningMode}>
					<option value="multi-hypothesis">Multi-hypothesis</option>
					<option value="single">Single plan</option>
				</select>
			</div>

			<div class="field-row">
				<label for="cost">Cost ceiling USD</label>
				<input id="cost" type="number" min="0" max="100" step="0.01" bind:value={settings.costCeilingUsd} />
			</div>

			<div class="field-row">
				<label for="token-ceiling">Token ceiling per run</label>
				<input id="token-ceiling" type="number" min="1000" max="2000000" step="1000" bind:value={settings.maxTokensPerRun} />
			</div>

			<label for="paths">Allowed file paths</label>
			<textarea id="paths" rows="6" bind:value={settings.allowedPaths}></textarea>

			<label for="network">Network allowlist</label>
			<textarea id="network" rows="4" bind:value={settings.networkAllowlist}></textarea>

			<div class="provider-card">
				<strong>Source-write approval</strong>
				<small>Always enforced. High-risk source writes require a path-bound operator approval record.</small>
			</div>

			<button class="button button--primary" type="button" onclick={saveSettings} disabled={isSaving}>
				{isSaving ? 'Saving...' : 'Save settings'}
			</button>

			{#if saveStatus}
				<p class="source-write-status">{saveStatus}</p>
			{/if}
		</form>

		<aside class="panel">
			<div class="panel__header">
				<h2>Provider status</h2>
				<span class="mini-badge">{data.providers.length} providers</span>
			</div>
			<div class="probe-list">
				{#each data.providers as provider}
					<article data-status={provider.status === 'ready' ? 'passed' : 'blocked'}>
						<span>{provider.status}</span>
						<div>
							<strong>{provider.name}</strong>
							<small>
								{provider.checkedAt
									? `${provider.reliabilityScore}% reliability / ${provider.probeSource}`
									: 'probes not run'}
							</small>
						</div>
					</article>
				{/each}
			</div>
		</aside>
	</section>

	{#if data.platformAdmin}
		<section class="organization-admin" aria-labelledby="organization-title">
			<header class="section-heading"><div><h2 id="organization-title">Organization provisioning</h2><p>Platform-level tenant creation with an atomic first-administrator credential.</p></div><span class="environment-badge">{organizations.length} organizations</span></header>
			<div class="organization-layout">
				<div class="organization-list" role="table" aria-label="Organizations">
					<div class="organization-row organization-row--header" role="row"><span>Organization</span><span>Slug</span><span>Status</span><span>Created</span><span>Action</span></div>
					{#each organizations as organization}
						<div class="organization-row" role="row"><span><strong>{organization.name}</strong><small>{organization.id === data.currentTenantId ? 'Current organization' : organization.id}</small></span><code>{organization.slug}</code><span class="step-state" data-status={organization.status === 'active' ? 'verified' : 'failed'}>{organization.status}</span><time datetime={organization.createdAt}>{organization.createdAt ? new Date(organization.createdAt).toLocaleDateString() : 'pending'}</time><button class="quiet-button" type="button" disabled={organization.id === data.currentTenantId} title={organization.id === data.currentTenantId ? 'Use a platform administrator from another active organization' : `${organization.status === 'active' ? 'Suspend' : 'Reactivate'} ${organization.name}`} onclick={() => changeOrganizationStatus(organization)}>{organization.status === 'active' ? 'Suspend' : 'Reactivate'}</button></div>
					{:else}<div class="context-empty">No organizations are registered.</div>{/each}
				</div>
				<form class="organization-form" onsubmit={provisionOrganization}>
					<h3>Create organization</h3>
					<label for="organization-name">Organization name</label><input id="organization-name" bind:value={organizationName} required maxlength="160" placeholder="Northwind Engineering" />
					<label for="organization-slug">Organization slug</label><input id="organization-slug" bind:value={organizationSlug} required minlength="3" maxlength="64" pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" placeholder="northwind-engineering" />
					<label for="organization-admin-id">Initial administrator ID</label><input id="organization-admin-id" bind:value={organizationAdminId} required placeholder="admin@example.com" />
					<label for="organization-admin-name">Administrator display name</label><input id="organization-admin-name" bind:value={organizationAdminName} required maxlength="160" placeholder="Platform Administrator" />
					<button class="primary-command" type="submit" disabled={isProvisioningOrganization || Boolean(data.organizationError)}>{isProvisioningOrganization ? 'Creating organization...' : 'Create organization'}</button>
					{#if organizationToken}<div class="issued-token" role="status"><strong>One-time initial administrator token</strong><code>{organizationToken}</code><small>This token selects the new organization automatically. Send it once through an approved secret channel.</small><button class="secondary-command" type="button" onclick={copyOrganizationToken}>Copy token</button></div>{/if}
					{#if organizationStatus}<p class="field-help" role="status">{organizationStatus}</p>{/if}
				</form>
			</div>
		</section>
	{/if}

	<section class="sso-admin" aria-labelledby="sso-title">
		<header class="section-heading"><div><h2 id="sso-title">Company SSO</h2><p>Organization-owned OpenID Connect credentials with encrypted secret storage and live provider validation.</p></div><span class="environment-badge">{ssoConnection?.status ?? (data.ssoDeploymentFallback ? 'deployment fallback' : 'not configured')}</span></header>
		<div class="sso-layout">
			<div class="sso-summary">
				<div><span>Callback URL</span><code>{data.oidcCallbackUrl}</code><button class="quiet-button" type="button" onclick={copySsoCallback}>Copy URL</button></div>
				<div><span>Credential state</span><strong>{ssoConnection?.secretConfigured ? 'Encrypted tenant secret configured' : data.ssoDeploymentFallback ? 'Deployment-managed fallback' : 'No tenant secret'}</strong></div>
				<div><span>Provider</span><strong>{ssoConnection?.issuer ?? 'Not connected'}</strong></div>
				{#if ssoConnection}<button class="secondary-command" type="button" onclick={changeSsoStatus}>{ssoConnection.status === 'active' ? 'Disable company SSO' : 'Enable company SSO'}</button>{/if}
			</div>
			<form class="sso-form-admin" onsubmit={saveSso}>
				<h3>{ssoConnection ? 'Rotate or update connection' : 'Connect identity provider'}</h3>
				<label for="sso-display-name">Sign-in button name</label><input id="sso-display-name" bind:value={ssoDisplayName} required maxlength="80" placeholder="Northwind SSO" />
				<label for="sso-issuer">Issuer URL</label><input id="sso-issuer" type="url" bind:value={ssoIssuer} required maxlength="500" placeholder="https://login.example.com/tenant/v2.0" />
				<label for="sso-client-id">Client ID</label><input id="sso-client-id" bind:value={ssoClientId} required maxlength="500" autocomplete="off" />
				<label for="sso-client-secret">{ssoConnection ? 'New client secret' : 'Client secret'}</label><input id="sso-client-secret" type="password" bind:value={ssoClientSecret} required minlength="16" maxlength="2048" autocomplete="new-password" placeholder="Paste once; it cannot be retrieved" />
				<label for="sso-scopes">Scopes</label><input id="sso-scopes" bind:value={ssoScopes} required maxlength="500" />
				<label for="sso-origins">Additional trusted endpoint origins</label><textarea id="sso-origins" rows="3" bind:value={ssoAllowedOrigins} placeholder="https://identity-cdn.example.com"></textarea>
				<button class="primary-command" type="submit" disabled={isSavingSso || Boolean(data.ssoError)}>{isSavingSso ? 'Validating provider...' : ssoConnection ? 'Validate and rotate credentials' : 'Validate and connect SSO'}</button>
				{#if ssoStatus}<p class="field-help" role="status">{ssoStatus}</p>{/if}
			</form>
		</div>
	</section>

	<section class="lifecycle-admin" aria-labelledby="lifecycle-title">
		<header class="section-heading"><div><h2 id="lifecycle-title">Automated provisioning</h2><p>Expiring company invitations and standards-based directory lifecycle management.</p></div><span class="environment-badge">{invitations.filter((item) => item.status === 'pending').length} pending</span></header>
		<div class="lifecycle-layout">
			<div class="invitation-admin">
				<div class="subsection-heading"><h3>Company invitations</h3><p>A verified SSO email redeems one matching invitation once.</p></div>
				<form class="invitation-form" onsubmit={createInvitation}>
					<label for="invitation-email">Work email</label><input id="invitation-email" type="email" bind:value={invitationEmail} required maxlength="254" placeholder="alice@example.com" />
					<label for="invitation-role">Organization role</label><select id="invitation-role" bind:value={invitationRole}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Administrator</option></select>
					<label for="invitation-days">Expires after</label><select id="invitation-days" bind:value={invitationDays}><option value={1}>1 day</option><option value={3}>3 days</option><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option></select>
					<button class="primary-command" type="submit" disabled={isInviting || Boolean(data.lifecycleError)}>{isInviting ? 'Creating invitation...' : 'Create invitation'}</button>
				</form>
				{#if invitationStatus}<p class="field-help" role="status">{invitationStatus}</p>{/if}
				<div class="invitation-list" role="table" aria-label="Company invitations">
					<div class="invitation-row invitation-row--header" role="row"><span>Email</span><span>Role</span><span>Expires</span><span>Action</span></div>
					{#each invitations as invitation}
						<div class="invitation-row" role="row"><span><strong>{invitation.email}</strong><small>{invitation.status}</small></span><span>{invitation.role}</span><time datetime={invitation.expiresAt}>{new Date(invitation.expiresAt).toLocaleDateString()}</time><span>{#if invitation.status === 'pending'}<button class="quiet-button" type="button" onclick={() => revokeInvitation(invitation)}>Revoke</button>{:else}<small>{invitation.status}</small>{/if}</span></div>
					{:else}<div class="context-empty">No invitations have been created.</div>{/each}
				</div>
			</div>
			<div class="scim-admin">
				<div class="subsection-heading"><h3>SCIM 2.0 connection</h3><p>Provision and deactivate users from the company identity provider.</p></div>
				<div class="scim-summary">
					<div><span>Base URL</span><code>{data.scimEndpoint}</code><button class="quiet-button" type="button" onclick={() => copyScimValue(data.scimEndpoint, 'SCIM base URL copied.')}>Copy</button></div>
					<div><span>Status</span><strong>{scimConnection?.status ?? 'Not configured'}</strong>{#if scimConnection}<button class="quiet-button" type="button" onclick={changeScimStatus}>{scimConnection.status === 'active' ? 'Disable' : 'Enable'}</button>{/if}</div>
					<div><span>Last request</span><strong>{scimConnection?.lastUsedAt ? new Date(scimConnection.lastUsedAt).toLocaleString() : 'No authenticated requests'}</strong></div>
				</div>
				<form class="scim-form" onsubmit={configureScim}>
					<label for="scim-name">Connection name</label><input id="scim-name" bind:value={scimDisplayName} required maxlength="80" />
					<button class="secondary-command" type="submit" disabled={isSavingScim || Boolean(data.lifecycleError)}>{isSavingScim ? 'Rotating token...' : scimConnection ? 'Rotate bearer token' : 'Create connection'}</button>
				</form>
				{#if scimToken}<div class="issued-token" role="status"><strong>One-time SCIM bearer token</strong><code>{scimToken}</code><small>Enter this token in the identity provider now. KcevAgent stores only its SHA-256 digest.</small><button class="secondary-command" type="button" onclick={() => copyScimValue(scimToken, 'SCIM bearer token copied.')}>Copy token</button></div>{/if}
				{#if scimStatus}<p class="field-help" role="status">{scimStatus}</p>{/if}
			</div>
		</div>
	</section>

	<section class="identity-admin" aria-labelledby="identity-title">
		<header class="section-heading"><div><h2 id="identity-title">Identity and access</h2><p>Named tenant identities with server-enforced roles and immediate revocation.</p></div><div class="header-actions"><a href="/audit">Open audit log</a><span class="environment-badge">{identities.filter((identity) => identity.status === 'active').length} active</span></div></header>
		<div class="identity-layout">
			<div class="identity-list" role="table" aria-label="Tenant identities">
				<div class="identity-row identity-row--header" role="row"><span>Name</span><span>Role</span><span>Status</span><span>Action</span></div>
				{#each identities as identity}
					<div class="identity-row" role="row"><span><strong>{identity.displayName}</strong><small>{identity.id}</small></span><span>{identity.role}</span><span class="step-state" data-status={identity.status === 'active' ? 'verified' : 'failed'}>{identity.status}</span><span><button class="quiet-button" type="button" onclick={() => revokeIdentity(identity)} disabled={identity.status !== 'active'}>Revoke</button></span></div>
				{:else}<div class="context-empty">No durable identities have been created.</div>{/each}
			</div>
			<form class="identity-form" onsubmit={issueIdentity}>
				<h3>Add or rotate access</h3>
				<label for="identity-id">Identity ID</label><input id="identity-id" bind:value={identityId} required placeholder="alice@example.com" />
				<label for="identity-name">Display name</label><input id="identity-name" bind:value={identityName} required placeholder="Alice" />
				<label for="identity-role">Role</label><select id="identity-role" bind:value={identityRole}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Administrator</option></select>
				<button class="primary-command" type="submit" disabled={isIssuingIdentity || Boolean(data.identityError)}>{isIssuingIdentity ? 'Issuing...' : 'Issue access'}</button>
				{#if issuedToken}<div class="issued-token" role="status"><strong>One-time access token</strong><code>{issuedToken}</code><button class="secondary-command" type="button" onclick={copyIssuedToken}>Copy token</button></div>{/if}
				{#if identityStatus}<p class="field-help" role="status">{identityStatus}</p>{/if}
			</form>
		</div>
	</section>

	<section class="membership-admin" aria-labelledby="membership-title">
		<header class="section-heading"><div><h2 id="membership-title">Organization memberships</h2><p>Grant an existing account access without issuing another credential.</p></div><span class="environment-badge">{memberships.filter((membership) => membership.status === 'active').length} active</span></header>
		{#if data.identity.accountReference}<div class="membership-reference"><span>Your account reference</span><code>{data.identity.accountReference}</code><button class="quiet-button" type="button" onclick={copyAccountReference}>Copy</button></div>{/if}
		<div class="membership-layout">
			<div class="membership-list" role="table" aria-label="Organization memberships">
				<div class="membership-row membership-row--header" role="row"><span>Account</span><span>Role</span><span>Type</span><span>Status</span><span>Action</span></div>
				{#each memberships as membership}
					<div class="membership-row" role="row"><span><strong>{membership.displayName}</strong><small>{membership.identityId} / {membership.role} / {membership.status}</small></span><span>{membership.role}</span><span>{membership.homeOrganization ? 'Home' : 'External'}</span><span class="step-state" data-status={membership.status === 'active' ? 'verified' : 'failed'}>{membership.status}</span><span>{#if membership.homeOrganization}<small>Identity managed</small>{:else}<button class="quiet-button" type="button" disabled={membership.status !== 'active' || (membership.accountTenantId === data.identity.accountTenantId && membership.identityId === data.identity.subject)} onclick={() => revokeMembership(membership)}>Remove</button>{/if}</span></div>
				{:else}<div class="context-empty">No organization memberships are available.</div>{/each}
			</div>
			<form class="membership-form" onsubmit={grantMembership}>
				<h3>Grant existing account</h3>
				<label for="membership-account">Account reference</label><input id="membership-account" bind:value={membershipAccountReference} required placeholder="organization-id:identity-id" autocomplete="off" />
				<label for="membership-role">Role in this organization</label><select id="membership-role" bind:value={membershipRole}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Administrator</option></select>
				<button class="primary-command" type="submit" disabled={isSavingMembership || Boolean(data.identityError)}>{isSavingMembership ? 'Granting access...' : 'Grant access'}</button>
				{#if membershipStatus}<p class="field-help" role="status">{membershipStatus}</p>{/if}
			</form>
		</div>
	</section>
</main>
</AppShell>
