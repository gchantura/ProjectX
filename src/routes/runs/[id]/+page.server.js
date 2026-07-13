import { error } from '@sveltejs/kit';
import { getRunEvents, getRunLedger, getStoredRun } from '$lib/agent/runStore.server.js';
import { deriveTaskGraph } from '$lib/agent/taskGraph.server.js';

export async function load({ params }) {
	const [run, ledger, events] = await Promise.all([getStoredRun(params.id), getRunLedger(params.id), getRunEvents(params.id)]);

	if (!run || !ledger) {
		throw error(404, 'Run not found.');
	}

	return { run, ledger, events: events ?? [], graph: deriveTaskGraph(run) };
}
