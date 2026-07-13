import { error, json } from '@sveltejs/kit';
import { getRunLedger } from '$lib/agent/runStore.server.js';

export async function GET({ params }) {
	const ledger = await getRunLedger(params.id);
	if (!ledger) throw error(404, 'Run ledger not found.');

	return json({ ledger });
}
