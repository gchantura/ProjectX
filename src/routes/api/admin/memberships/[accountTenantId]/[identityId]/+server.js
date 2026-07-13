import { json } from '@sveltejs/kit';
import { createIdentityStore } from '$lib/server/identityStore.server.js';

export async function DELETE({ params, locals }) {
	const accountTenantId = String(params.accountTenantId ?? '');
	const identityId = String(params.identityId ?? '');
	if (!validTenantId(accountTenantId) || !/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{1,127}$/.test(identityId)) return json({ error: 'Invalid account reference.' }, { status: 400 });
	if (accountTenantId === (locals.identity.accountTenantId ?? locals.identity.tenantId) && identityId === locals.identity.subject) return json({ error: 'You cannot revoke your own active membership.' }, { status: 409 });
	try { return json(await requireStore().revokeMembership(accountTenantId, identityId, locals.identity.subject), { headers: { 'cache-control': 'no-store' } }); }
	catch { return json({ error: 'Home organization access must be revoked through the identity directory; external membership revocation failed.' }, { status: 409 }); }
}

function validTenantId(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function requireStore() { const store = createIdentityStore(); if (!store) throw Object.assign(new Error('Organization membership requires Supabase configuration.'), { status: 503 }); return store; }
