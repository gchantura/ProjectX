import { error, json } from '@sveltejs/kit';
import { createProject, listProjects } from '$lib/agent/projectStore.server.js';

export async function GET() {
	return json({ projects: await listProjects() });
}

export async function POST({ request }) {
	try {
		const project = await createProject(await request.json());
		return json({ project }, { status: 201 });
	} catch (reason) {
		throw error(reason?.status || 400, reason?.message || 'Unable to register project.');
	}
}
