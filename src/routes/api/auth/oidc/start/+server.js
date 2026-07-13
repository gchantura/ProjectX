import { redirect } from '@sveltejs/kit';
import { securityConfig } from '$lib/server/security.js';
import { createOrganizationStore } from '$lib/server/organizationStore.server.js';
import { resolveTenantOidcConfig } from '$lib/server/oidcConnectionStore.server.js';
import { createOidcAuthorization, discoverOidc, oidcCookieOptions, sealOidcTransaction } from '$lib/server/oidc.server.js';

export async function GET({ url, cookies }) {
	const organizationSlug = String(url.searchParams.get('organization') ?? '').trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(organizationSlug)) throw redirect(303, '/login?sso=organization-required');
	try {
		const organization = await createOrganizationStore()?.findBySlug(organizationSlug);
		if (!organization) throw redirect(303, `/login?sso=organization-not-found&organization=${encodeURIComponent(organizationSlug)}`);
		if (organization.status !== 'active') throw redirect(303, `/login?sso=suspended&organization=${encodeURIComponent(organizationSlug)}`);
		const config = await resolveTenantOidcConfig(organization.id);
		if (!config) throw redirect(303, `/login?sso=organization-sso-unavailable&organization=${encodeURIComponent(organizationSlug)}`);
		const metadata = await discoverOidc(config);
		const redirectUri = `${url.origin}/api/auth/oidc/callback`;
		const authorization = createOidcAuthorization({ config, metadata, redirectUri, organization, returnTo: url.searchParams.get('returnTo') ?? '/' });
		cookies.set('kcev_oidc', sealOidcTransaction(authorization.transaction, securityConfig().sessionSecret), oidcCookieOptions(url));
		throw redirect(303, authorization.url);
	} catch (error) {
		if (error?.status === 303) throw error;
		throw redirect(303, `/login?sso=unavailable&organization=${encodeURIComponent(organizationSlug)}`);
	}
}
