import { error, json } from '@sveltejs/kit';
import {
	createApprovedSourceWrite,
	getSourceWriteApprovalPhrase
} from '$lib/agent/sourceWrite.server.js';
import { getAgentSettings, settingsToRunConfig } from '$lib/agent/settingsStore.server.js';
import { resolveProjectContext } from '$lib/agent/projectStore.server.js';


export async function GET({ url }) {
	const project = await resolveProjectContext(url.searchParams.get('projectId'));
	const settings = await getAgentSettings({ projectId: project.projectId });
	return json({
		approvalPhrase: getSourceWriteApprovalPhrase(),
		allowedRoots: ['src/', 'docs/', 'static/', 'tools/'],
		allowedPaths: settings.allowedPaths
	});
}

export async function POST({ request }) {
	try {
		const body = await request.json();
		const project = await resolveProjectContext(body.projectId);
		const settings = await getAgentSettings({ projectId: project.projectId });
		const sourceWrite = await createApprovedSourceWrite(body, { config: { ...settingsToRunConfig(settings), ...project } });
		return json({ sourceWrite }, { status: 201 });
	} catch (reason) {
		const status = reason?.status || 500;
		throw error(status, reason?.message || 'Unable to create source write.');
	}
}
