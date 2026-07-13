import { createHash, randomBytes } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { createIdentityStore } from '$lib/server/identityStore.server.js';

export async function GET() {
	const store = requireStore();
	return json({ identities: await store.list() });
}

export async function POST({ request, locals }) {
	const body = await request.json();
	const id = String(body?.id ?? '').trim();
	const displayName = String(body?.displayName ?? '').trim();
	const role = String(body?.role ?? 'operator');
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{1,127}$/.test(id) || !displayName || displayName.length > 160 || !['viewer', 'operator', 'admin'].includes(role)) {
		return json({ error: 'Provide a valid identity ID, display name, and role.' }, { status: 400 });
	}
	const token = `kcev_${randomBytes(32).toString('base64url')}`;
	const stored = await requireStore().upsert({ id, displayName, role, tokenSha256: createHash('sha256').update(token).digest('hex') }, locals.identity.subject);
	return json({ identity: stored, token }, { status: 201, headers: { 'cache-control': 'no-store' } });
}

function requireStore() {
	const store = createIdentityStore();
	if (!store) throw Object.assign(new Error('The durable identity directory requires Supabase configuration.'), { status: 503 });
	return store;
}
