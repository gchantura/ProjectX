import { createHash, randomBytes } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { createOrganizationStore } from '$lib/server/organizationStore.server.js';

export async function GET({ locals }) {
	const denied = requirePlatformAdmin(locals.identity);
	if (denied) return denied;
	return json({ organizations: await requireStore().list() });
}

export async function POST({ request, locals }) {
	const denied = requirePlatformAdmin(locals.identity);
	if (denied) return denied;
	const body = await request.json().catch(() => null);
	const name = String(body?.name ?? '').trim();
	const slug = String(body?.slug ?? '').trim().toLowerCase();
	const adminId = String(body?.adminId ?? '').trim();
	const adminDisplayName = String(body?.adminDisplayName ?? '').trim();
	if (!name || name.length > 160 || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug) || !/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{1,127}$/.test(adminId) || !adminDisplayName || adminDisplayName.length > 160) {
		return json({ error: 'Provide a valid organization name, 3-64 character slug, administrator ID, and display name.' }, { status: 400 });
	}
	const token = `kcev_${randomBytes(32).toString('base64url')}`;
	try {
		const result = await requireStore().provision({ name, slug, admin: { id: adminId, displayName: adminDisplayName, tokenSha256: createHash('sha256').update(token).digest('hex') } }, locals.identity.subject);
		return json({ ...result, token }, { status: 201, headers: { 'cache-control': 'no-store', pragma: 'no-cache' } });
	} catch (error) {
		return json({ error: error?.message || 'Organization provisioning failed.' }, { status: error?.status >= 400 && error?.status < 500 ? error.status : 503 });
	}
}

function requirePlatformAdmin(identity) {
	return identity?.authenticated && identity.platformAdmin === true ? null : json({ error: 'Platform administrator authority required.' }, { status: 403 });
}

function requireStore() {
	const store = createOrganizationStore();
	if (!store) throw Object.assign(new Error('Organization provisioning requires Supabase configuration.'), { status: 503 });
	return store;
}
