import { json } from '@sveltejs/kit';
import { createTenantIdentityLifecycleStore } from '$lib/server/identityLifecycleStore.server.js';

export async function GET({ locals }) {
	return json({ invitations: await requireStore(locals).listInvitations() }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST({ request, locals }) {
	const body = await request.json().catch(() => ({}));
	const email = String(body?.email ?? '').trim().toLowerCase();
	const role = String(body?.role ?? 'operator');
	const expiresInDays = Number(body?.expiresInDays ?? 7);
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['viewer', 'operator', 'admin'].includes(role) || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
		return json({ error: 'Provide a valid email, role, and expiration from 1 to 30 days.' }, { status: 400 });
	}
	const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
	const invitation = await requireStore(locals).createInvitation({ email, role, expiresAt }, locals.identity.subject);
	return json({ invitation }, { status: 201, headers: { 'cache-control': 'no-store' } });
}

function requireStore(locals) {
	const store = createTenantIdentityLifecycleStore(locals.identity.tenantId);
	if (!store) throw Object.assign(new Error('Managed invitations require Supabase configuration.'), { status: 503 });
	return store;
}
