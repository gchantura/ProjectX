import { error, json } from '@sveltejs/kit';
import { getStoredRun } from '$lib/agent/runStore.server.js';
import { rejectRunPreflight } from '$lib/agent/runPreflight.server.js';

export async function DELETE({ params, locals }) {
	try {
		const run = await getStoredRun(params.id);
		if (!run) throw Object.assign(new Error('Run not found.'), { status: 404 });
		return json(await rejectRunPreflight(run, { actor: locals.identity?.subject }));
	} catch (reason) {
		throw error(reason?.status || 500, reason?.message || 'Unable to reject plan approval.');
	}
}
