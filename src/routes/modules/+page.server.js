import { listModuleReadiness } from '$lib/agent/moduleRegistry.server.js';
import { getAgentSettings } from '$lib/agent/settingsStore.server.js';
import { resolveProjectContext } from '$lib/agent/projectStore.server.js';

export async function load() {
	const project = await resolveProjectContext();
	return {
		modules: listModuleReadiness(),
		settings: await getAgentSettings({ projectId: project.projectId })
	};
}
