import { json } from '@sveltejs/kit';
import { listMemories, remember } from '$lib/agent/memoryStore.server.js';
import { resolveProjectContext } from '$lib/agent/projectStore.server.js';

export async function GET({ url }) {
	try {
		const project = await resolveProjectContext(url.searchParams.get('projectId'));
		return json({ memories: await listMemories({ projectId: project.projectId }) });
	} catch (error) { return json({ error: error?.message ?? 'Unable to list memory.' }, { status: error?.status ?? 400 }); }
}

export async function POST({ request }) {
	try {
		const body = await request.json();
		const project = await resolveProjectContext(body.projectId);
		const memory = await remember({ projectId: project.projectId, projectName: project.projectName, scope: project.projectId, kind: body.kind, content: body.content, tags: body.tags, importance: body.importance, expiresAt: body.expiresAt });
		return json({ memory }, { status: 201 });
	} catch (error) { return json({ error: error?.message ?? 'Unable to save memory.' }, { status: error?.status ?? 400 }); }
}
