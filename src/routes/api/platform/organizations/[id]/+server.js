import { json } from '@sveltejs/kit';
import { createOrganizationStore } from '$lib/server/organizationStore.server.js';
import { authorizeOrganizationStatusChange } from '$lib/server/organizationLifecycle.js';

export async function PATCH({ params, request, locals }) {
	const id = String(params.id ?? '');
	const body = await request.json().catch(() => null);
	const status = String(body?.status ?? '');
	const authorization = authorizeOrganizationStatusChange(locals.identity, id, status);
	if (!authorization.allowed) return json({ error: authorization.reason }, { status: authorization.status });
	const store = createOrganizationStore();
	if (!store) return json({ error: 'Organization lifecycle management requires Supabase configuration.' }, { status: 503 });
	try {
		const result = await store.updateStatus(id, status, locals.identity.subject);
		return json(result, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		return json({ error: error?.message || 'Organization lifecycle update failed.' }, { status: error?.status >= 400 && error?.status < 500 ? error.status : 503 });
	}
}
