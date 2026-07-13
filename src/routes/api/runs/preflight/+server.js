import { error, json } from '@sveltejs/kit';
import { assertRunAdmission } from '$lib/agent/runAdmission.server.js';
import { createRunPreflight } from '$lib/agent/runPreflight.server.js';

export async function POST({ request, locals }) {
	try {
		const body = await request.json();
		const admission = await assertRunAdmission({ ...body, actor: locals.identity?.subject, correlationId: locals.requestId });
		const preflight = await createRunPreflight({ ...body, config: admission.config }, { signal: request.signal });
		return json(preflight, { status: 201 });
	} catch (reason) {
		throw error(reason?.status || 500, reason?.message || 'Unable to create run preflight.');
	}
}
