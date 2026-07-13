import { error, json } from '@sveltejs/kit';
import { listStoredRuns } from '$lib/agent/runStore.server.js';
import { assertRunAdmission } from '$lib/agent/runAdmission.server.js';
import { createRunPreflight } from '$lib/agent/runPreflight.server.js';

export async function GET({ url }) {
	const projectId = url.searchParams.get('projectId') || undefined;
	const runs = await listStoredRuns({ projectId });
	return json({ runs });
}

export async function POST({ request, locals }) {
	try {
		const body = await request.json();
		const admission = await assertRunAdmission({ ...body, actor: locals.identity?.subject, correlationId: locals.requestId });
		const preflight = await createRunPreflight({ ...body, config: admission.config }, { signal: request.signal });
		return json(preflight, { status: 201 });
	} catch (reason) {
		const status = reason?.status || 500;
		throw error(status, reason?.message || 'Unable to create run.');
	}
}
