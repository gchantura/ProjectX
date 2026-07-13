import { error, json } from '@sveltejs/kit';
import { getStoredRun } from '$lib/agent/runStore.server.js';
import { deriveTaskGraph } from '$lib/agent/taskGraph.server.js';

export async function GET({ params }) {
	const run = await getStoredRun(params.id);
	if (!run) throw error(404, 'Run not found.');

	return json({ graph: deriveTaskGraph(run) });
}
