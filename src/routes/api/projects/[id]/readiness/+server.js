import { error, json } from '@sveltejs/kit';
import { collectProjectReadiness } from '$lib/agent/projectReadiness.server.js';

export async function GET({ params }) {
	try {
		return json({ readiness: await collectProjectReadiness(params.id) });
	} catch (reason) {
		throw error(reason?.status || 500, reason?.message || 'Unable to inspect project readiness.');
	}
}
