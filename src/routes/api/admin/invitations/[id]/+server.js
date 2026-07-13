import { json } from '@sveltejs/kit';
import { createTenantIdentityLifecycleStore } from '$lib/server/identityLifecycleStore.server.js';

export async function DELETE({ params, locals }) {
	if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(params.id)) return json({ error: 'Invalid invitation identifier.' }, { status: 400 });
	const store = createTenantIdentityLifecycleStore(locals.identity.tenantId);
	if (!store) return json({ error: 'Managed invitations require Supabase configuration.' }, { status: 503 });
	const result = await store.revokeInvitation(params.id, locals.identity.subject);
	return result?.revoked ? json(result) : json({ error: 'Pending invitation not found.' }, { status: 404 });
}
