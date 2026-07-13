import { error, json } from '@sveltejs/kit';
import { getAgentSettings, saveAgentSettings } from '$lib/agent/settingsStore.server.js';
import { resolveProjectContext } from '$lib/agent/projectStore.server.js';

export async function GET({ url }) {
	const project = await resolveProjectContext(url.searchParams.get('projectId'));
	const settings = await getAgentSettings({ projectId: project.projectId });
	return json({ settings });
}

export async function POST({ request }) {
	try {
		const body = await request.json();
		const project = await resolveProjectContext(body.projectId);
		const settings = await saveAgentSettings(body, { projectId: project.projectId });
		return json({ settings });
	} catch (reason) {
		throw error(reason?.status || 400, reason?.message || 'Unable to save settings.');
	}
}
