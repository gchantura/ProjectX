import { listStoredRuns } from '$lib/agent/runStore.server.js';

export async function load() {
	const runs = await listStoredRuns({ limit: 100 });
	return { runs };
}
