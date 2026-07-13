import { json } from '@sveltejs/kit';
import { createIdentityStore } from '$lib/server/identityStore.server.js';

export async function DELETE({ params, locals }) {
	if (params.id === locals.identity.subject) return json({ error: 'You cannot revoke your own active identity.' }, { status: 409 });
	const store = createIdentityStore();
	if (!store) return json({ error: 'The durable identity directory requires Supabase configuration.' }, { status: 503 });
	const result = await store.revoke(params.id, locals.identity.subject);
	return result?.revoked ? json(result) : json({ error: 'Active identity not found.' }, { status: 404 });
}
