import { json } from '@sveltejs/kit';
import { forget } from '$lib/agent/memoryStore.server.js';
import { resolveProjectContext } from '$lib/agent/projectStore.server.js';

export async function DELETE({ params, url }) {
	const project = await resolveProjectContext(url.searchParams.get('projectId'));
	const deleted = await forget(params.id, { projectId: project.projectId });
	return deleted ? new Response(null, { status: 204 }) : json({ error: 'Memory not found.' }, { status: 404 });
}
