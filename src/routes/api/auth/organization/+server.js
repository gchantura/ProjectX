import { json } from '@sveltejs/kit';
import { createIdentityStore } from '$lib/server/identityStore.server.js';
import { createSessionToken, securityConfig, sessionCookieOptions } from '$lib/server/security.js';

export async function GET({ locals }) {
	const identity = locals.identity;
	const store = requireStore();
	const memberships = await store.listMemberships(identity.accountTenantId ?? identity.tenantId, identity.subject);
	return json({ memberships: memberships.map(publicMembership), activeTenantId: identity.tenantId }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST({ request, locals, cookies, url }) {
	const body = await request.json().catch(() => ({}));
	const tenantId = String(body?.tenantId ?? '');
	if (!validTenantId(tenantId)) return json({ error: 'Select a valid organization.' }, { status: 400 });
	const current = locals.identity;
	const member = await requireStore().resolveMembership(current.accountTenantId ?? current.tenantId, current.subject, tenantId);
	if (!member) return json({ error: 'You do not have active access to that organization.' }, { status: 403 });
	const identity = { authenticated: true, subject: member.id, displayName: member.displayName, role: member.role, method: 'organization-switch', tenantId: member.tenantId, accountTenantId: member.accountTenantId, tenantName: member.tenantName };
	cookies.set('kcev_session', createSessionToken(identity, securityConfig()), sessionCookieOptions(url));
	return json({ identity: { name: identity.displayName, role: identity.role, organization: identity.tenantName, tenantId: identity.tenantId } }, { headers: { 'cache-control': 'no-store' } });
}

function publicMembership(member) { return { tenantId: member.tenantId, name: member.tenantName, slug: member.tenantSlug, role: member.role, status: member.status, tenantStatus: member.tenantStatus }; }
function validTenantId(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function requireStore() { const store = createIdentityStore(); if (!store) throw Object.assign(new Error('Organization membership requires Supabase configuration.'), { status: 503 }); return store; }
