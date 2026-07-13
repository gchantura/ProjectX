import { redirect } from '@sveltejs/kit';
import { createIdentityStore } from '$lib/server/identityStore.server.js';
import { createTenantIdentityLifecycleStore } from '$lib/server/identityLifecycleStore.server.js';
import { authorizeOidcMember, authorizeOidcOrganization } from '$lib/server/federatedAccess.js';
import { resolveTenantOidcConfig } from '$lib/server/oidcConnectionStore.server.js';
import { createSessionToken, securityConfig, sessionCookieOptions } from '$lib/server/security.js';
import { discoverOidc, exchangeOidcCode, oidcCookieOptions, openOidcTransaction, validateOidcConfigFingerprint, validateOidcState, verifyOidcIdToken } from '$lib/server/oidc.server.js';

export async function GET({ url, cookies }) {
	const cookieOptions = oidcCookieOptions(url);
	const sealed = cookies.get('kcev_oidc');
	cookies.delete('kcev_oidc', { ...cookieOptions, maxAge: 0 });
	let transaction;
	try {
		if (url.searchParams.get('error')) throw new Error('Provider rejected authentication.');
		const code = url.searchParams.get('code');
		const returnedState = url.searchParams.get('state');
		const security = securityConfig();
		if (!code || !returnedState) throw new Error('Incomplete OIDC callback.');
		transaction = openOidcTransaction(sealed, security.sessionSecret);
		if (!validateOidcState(returnedState, transaction)) throw new Error('OIDC state validation failed.');
		const store = createIdentityStore();
		const organization = await store?.tenantStatus(transaction.tenantId);
		const organizationAccess = authorizeOidcOrganization(transaction, organization);
		if (!organizationAccess.allowed) throw Object.assign(new Error(organizationAccess.reason), organizationAccess);
		const config = await resolveTenantOidcConfig(transaction.tenantId);
		if (!config) throw Object.assign(new Error('Company SSO is not configured for this organization.'), { status: 403, code: 'organization-sso-unavailable' });
		if (!validateOidcConfigFingerprint(transaction, config)) throw Object.assign(new Error('Company SSO configuration changed during sign-in.'), { status: 409, code: 'configuration-changed' });
		const metadata = await discoverOidc(config);
		const tokens = await exchangeOidcCode({ config, metadata, code, transaction });
		const claims = await verifyOidcIdToken({ config, metadata, idToken: tokens.id_token, nonce: transaction.nonce });
		let member = typeof store.resolveFederatedMembership === 'function' ? await store.resolveFederatedMembership(transaction.tenantId, claims.email) : await store.get(claims.email, { tenantId: transaction.tenantId });
		if (!member) {
			const lifecycleStore = createTenantIdentityLifecycleStore(transaction.tenantId);
			member = await lifecycleStore?.redeemOidcInvitation(transaction.tenantId, { email: claims.email, displayName: claims.name, issuer: claims.issuer, subject: claims.subject });
		}
		const memberAccess = authorizeOidcMember(transaction, member);
		if (!memberAccess.allowed) throw Object.assign(new Error(memberAccess.reason), memberAccess);
		await store.recordFederatedLogin(member.id, claims.issuer, claims.subject, { tenantId: transaction.tenantId, accountTenantId: member.accountTenantId ?? transaction.tenantId });
		const identity = { authenticated: true, subject: member.id, displayName: member.displayName, role: member.role, method: 'oidc', tenantId: transaction.tenantId, accountTenantId: member.accountTenantId ?? transaction.tenantId, tenantName: organization.name };
		cookies.set('kcev_session', createSessionToken(identity, security), sessionCookieOptions(url));
		throw redirect(303, transaction.returnTo);
	} catch (error) {
		if (error?.status === 303) throw error;
		const outcome = error?.code === 'suspended' ? 'suspended' : error?.code === 'organization-not-found' ? 'organization-not-found' : error?.code === 'organization-sso-unavailable' ? 'organization-sso-unavailable' : error?.code === 'configuration-changed' ? 'configuration-changed' : error?.status === 403 ? 'not-provisioned' : 'failed';
		const organization = transaction?.tenantSlug ? `&organization=${encodeURIComponent(transaction.tenantSlug)}` : '';
		throw redirect(303, `/login?sso=${outcome}${organization}`);
	}
}
