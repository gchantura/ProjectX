import { error, json } from '@sveltejs/kit';
import { getRunEvents, getStoredRun } from '$lib/agent/runStore.server.js';

export async function GET({ params }) {
	const [run, events] = await Promise.all([getStoredRun(params.id), getRunEvents(params.id)]);
	if (!run || !events) throw error(404, 'Run events not found.');
	return json({ events });
}
