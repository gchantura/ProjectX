import { oidcConfig } from '$lib/server/oidc.server.js';
import { getSupabaseConfig } from '$lib/agent/supabaseStore.server.js';
import { securityConfig } from '$lib/server/security.js';
import { accessPresentation } from '$lib/server/loginPresentation.js';
import { createOidcConnectionStore } from '$lib/server/oidcConnectionStore.server.js';

export function load({ url }) {
	const oidc = oidcConfig();
	const oidcAvailable = Boolean(oidc || createOidcConnectionStore());
	const access = accessPresentation({ security: securityConfig(), directoryConfigured: Boolean(getSupabaseConfig()), oidcEnabled: oidcAvailable, production: process.env.NODE_ENV === 'production' });
	const sso = url.searchParams.get('sso');
	const ssoError = sso === 'organization-required' ? 'Enter the organization slug from your KcevAgent invitation before continuing with company sign-in.' : sso === 'organization-not-found' ? 'No organization matches that slug. Check your invitation or contact your administrator.' : sso === 'organization-sso-unavailable' ? 'Company sign-in is not configured for this organization. Ask an organization administrator to configure it in Administration.' : sso === 'configuration-changed' ? 'Company sign-in settings changed during authentication. Start the sign-in again.' : sso === 'suspended' ? 'This organization is suspended. Contact your platform administrator to restore access.' : sso === 'not-provisioned' ? 'Your company identity is valid, but your account has not been granted access to this organization.' : sso === 'failed' ? 'Company sign-in could not be validated. Try again or contact your administrator.' : sso === 'unavailable' ? 'Company sign-in is temporarily unavailable.' : '';
	const organization = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(url.searchParams.get('organization') ?? '') ? url.searchParams.get('organization') : '';
	const requestedReturnTo = url.searchParams.get('returnTo');
	const returnTo = requestedReturnTo?.startsWith('/') && !requestedReturnTo.startsWith('//') ? requestedReturnTo.slice(0, 500) : '/';
	return { oidc: oidcAvailable ? { enabled: true, displayName: oidc?.displayName ?? 'Company SSO' } : { enabled: false, displayName: '' }, access, ssoError, organization, returnTo };
}
