import { randomBytes } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { createTenantIdentityLifecycleStore } from '$lib/server/identityLifecycleStore.server.js';

export async function GET({ locals, url }) {
	const connection = await requireStore(locals).getScimConnection();
	return json({ connection, endpoint: `${url.origin}/api/scim/v2` }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST({ request, locals, url }) {
	const body = await request.json().catch(() => ({}));
	const displayName = String(body?.displayName ?? 'Directory provisioning').trim();
	if (!displayName || displayName.length > 80) return json({ error: 'Connection name must contain 1 to 80 characters.' }, { status: 400 });
	const token = `kcev_scim_${randomBytes(32).toString('base64url')}`;
	const connection = await requireStore(locals).configureScim(displayName, token, locals.identity.subject);
	return json({ connection, token, endpoint: `${url.origin}/api/scim/v2` }, { status: 201, headers: { 'cache-control': 'no-store' } });
}

export async function PATCH({ request, locals }) {
	const body = await request.json().catch(() => ({}));
	const status = String(body?.status ?? '');
	if (!['active', 'disabled'].includes(status)) return json({ error: 'SCIM status must be active or disabled.' }, { status: 400 });
	return json(await requireStore(locals).setScimStatus(status, locals.identity.subject), { headers: { 'cache-control': 'no-store' } });
}

function requireStore(locals) {
	const store = createTenantIdentityLifecycleStore(locals.identity.tenantId);
	if (!store) throw Object.assign(new Error('SCIM provisioning requires Supabase configuration.'), { status: 503 });
	return store;
}
