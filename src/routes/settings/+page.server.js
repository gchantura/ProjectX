import { getAgentSettings } from '$lib/agent/settingsStore.server.js';
import { listProviderReadiness } from '$lib/agent/providerRegistry.server.js';
import { listProjects, resolveProjectContext } from '$lib/agent/projectStore.server.js';
import { createIdentityStore } from '$lib/server/identityStore.server.js';
import { createTenantIdentityLifecycleStore } from '$lib/server/identityLifecycleStore.server.js';
import { createOrganizationStore } from '$lib/server/organizationStore.server.js';
import { createOidcConnectionStore } from '$lib/server/oidcConnectionStore.server.js';
import { oidcConfig } from '$lib/server/oidc.server.js';

export async function load({ url, locals }) {
	const project = await resolveProjectContext(url.searchParams.get('projectId'));
	const identityStore = createIdentityStore();
	let identities = [];
	let memberships = [];
	let identityError = '';
	if (identityStore) {
		try {
			[identities, memberships] = await Promise.all([identityStore.list(), identityStore.listOrganizationMembers()]);
		}
		catch { identityError = 'Apply the identity-directory migration before managing access.'; }
	} else identityError = 'Configure Supabase before managing durable identities.';
	const platformAdmin = locals.identity?.platformAdmin === true;
	let organizations = [];
	let organizationError = '';
	if (platformAdmin) {
		const organizationStore = createOrganizationStore();
		if (organizationStore) {
			try { organizations = await organizationStore.list(); }
			catch { organizationError = 'Apply the organization-provisioning migration before managing organizations.'; }
		} else organizationError = 'Configure Supabase before provisioning organizations.';
	}
	const oidcStore = createOidcConnectionStore();
	let ssoConnection;
	let ssoError = '';
	if (oidcStore) {
		try { ssoConnection = await oidcStore.get(locals.identity.tenantId); }
		catch { ssoError = 'Apply the tenant OIDC migration before configuring company sign-in.'; }
	} else ssoError = 'Configure Supabase and KCEV_SECRETS_ENCRYPTION_KEY before storing tenant SSO credentials.';
	const lifecycleStore = createTenantIdentityLifecycleStore(locals.identity.tenantId);
	let invitations = [];
	let scimConnection;
	let lifecycleError = '';
	if (lifecycleStore) {
		try { [invitations, scimConnection] = await Promise.all([lifecycleStore.listInvitations(), lifecycleStore.getScimConnection()]); }
		catch { lifecycleError = 'Apply the identity lifecycle automation migration before managing invitations or SCIM.'; }
	} else lifecycleError = 'Configure Supabase before managing invitations or SCIM provisioning.';
	const [settings, allProviders, projects] = await Promise.all([getAgentSettings({ projectId: project.projectId }), listProviderReadiness(), listProjects()]);
	const providers = allProviders.filter((provider) => provider.id !== 'deterministic-local');
	return { settings, providers, projects, selectedProjectId: project.projectId, identities, memberships, identityError, platformAdmin, currentTenantId: locals.identity?.tenantId, organizations, organizationError, ssoConnection, ssoError, ssoDeploymentFallback: !ssoConnection && Boolean(oidcConfig()), oidcCallbackUrl: `${url.origin}/api/auth/oidc/callback`, invitations, scimConnection, scimEndpoint: `${url.origin}/api/scim/v2`, lifecycleError };
}
