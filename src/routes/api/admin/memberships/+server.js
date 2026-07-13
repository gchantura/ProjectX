import { json } from '@sveltejs/kit';
import { createIdentityStore } from '$lib/server/identityStore.server.js';

export async function GET() {
	return json({ memberships: await requireStore().listOrganizationMembers() }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST({ request, locals }) {
	const body = await request.json().catch(() => ({}));
	const accountTenantId = String(body?.accountTenantId ?? '');
	const identityId = String(body?.identityId ?? '').trim();
	const role = String(body?.role ?? 'operator');
	if (!validTenantId(accountTenantId) || !/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{1,127}$/.test(identityId) || !['viewer', 'operator', 'admin'].includes(role)) return json({ error: 'Provide a valid account organization ID, identity ID, and role.' }, { status: 400 });
	if (accountTenantId === (locals.identity.accountTenantId ?? locals.identity.tenantId) && identityId === locals.identity.subject) return json({ error: 'You cannot change your own active membership.' }, { status: 409 });
	try {
		const membership = await requireStore().upsertMembership(accountTenantId, identityId, role, locals.identity.subject);
		return json({ membership }, { status: 201, headers: { 'cache-control': 'no-store' } });
	} catch (error) { return json({ error: error?.status === 404 ? 'Account not found.' : 'Unable to grant organization access.' }, { status: error?.status ?? 409 }); }
}

function validTenantId(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function requireStore() { const store = createIdentityStore(); if (!store) throw Object.assign(new Error('Organization membership requires Supabase configuration.'), { status: 503 }); return store; }
