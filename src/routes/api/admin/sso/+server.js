import { json } from '@sveltejs/kit';
import { createOidcConnectionStore } from '$lib/server/oidcConnectionStore.server.js';
import { discoverOidc, oidcConfigFromValues } from '$lib/server/oidc.server.js';

export async function GET({ locals }) {
	const denied = requireTenantAdmin(locals.identity);
	if (denied) return denied;
	return json({ connection: await requireStore().get(locals.identity.tenantId) });
}

export async function PUT({ request, locals }) {
	const denied = requireTenantAdmin(locals.identity);
	if (denied) return denied;
	const body = await request.json().catch(() => null);
	const displayName = String(body?.displayName ?? '').trim();
	const issuer = String(body?.issuer ?? '').trim();
	const clientId = String(body?.clientId ?? '').trim();
	const clientSecret = String(body?.clientSecret ?? '');
	const scopes = String(body?.scopes ?? 'openid profile email').trim();
	const allowedEndpointOrigins = [...new Set(String(body?.allowedEndpointOrigins ?? '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))].slice(0, 20);
	const candidate = oidcConfigFromValues({ displayName, issuer, clientId, clientSecret, scopes, allowedEndpointOrigins, source: 'validation', revision: 'validation' });
	if (!candidate || !displayName || displayName.length > 80 || issuer.length > 500 || clientId.length > 500 || clientSecret.length < 16 || clientSecret.length > 2048 || scopes.length > 500 || allowedEndpointOrigins.some((origin) => !isHttpsOrigin(origin))) {
		return json({ error: 'Provide a valid HTTPS issuer, display name, client ID, 16-2048 character client secret, scopes, and HTTPS endpoint origins.' }, { status: 400 });
	}
	try {
		await discoverOidc(candidate);
		const connection = await requireStore().upsert(locals.identity.tenantId, { displayName: candidate.displayName, issuer: candidate.issuer, clientId, clientSecret, scopes: candidate.scopes, allowedEndpointOrigins }, locals.identity.subject);
		return json({ connection }, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		return json({ error: error?.message || 'Company SSO configuration failed.' }, { status: error?.status >= 400 && error?.status < 600 ? error.status : 503 });
	}
}

export async function PATCH({ request, locals }) {
	const denied = requireTenantAdmin(locals.identity);
	if (denied) return denied;
	const body = await request.json().catch(() => null);
	const status = String(body?.status ?? '');
	if (!['active', 'disabled'].includes(status)) return json({ error: 'Provide an active or disabled status.' }, { status: 400 });
	try { return json({ connection: await requireStore().setStatus(locals.identity.tenantId, status, locals.identity.subject) }, { headers: { 'cache-control': 'no-store' } }); }
	catch (error) { return json({ error: error?.message || 'Company SSO status update failed.' }, { status: error?.status >= 400 && error?.status < 600 ? error.status : 503 }); }
}

function requireTenantAdmin(identity) { return identity?.authenticated && identity.role === 'admin' ? null : json({ error: 'Organization administrator role required.' }, { status: 403 }); }
function requireStore() { const store = createOidcConnectionStore(); if (!store) throw Object.assign(new Error('Company SSO requires Supabase and KCEV_SECRETS_ENCRYPTION_KEY.'), { status: 503 }); return store; }
function isHttpsOrigin(value) { try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value.replace(/\/$/, '') && !url.username && !url.password; } catch { return false; } }
