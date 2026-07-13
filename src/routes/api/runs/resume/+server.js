import { error } from '@sveltejs/kit';
import { createResumeEventStream } from '$lib/agent/runStream.server.js';
import { assertResumeAdmission } from '$lib/agent/runAdmission.server.js';
import { acquireRunLease } from '$lib/agent/runLease.server.js';

export async function POST({ request, locals }) {
	try {
		const body = await request.json();
		const admission = await assertResumeAdmission({ ...body, actor: locals.identity?.subject, correlationId: locals.requestId });
		const lease = await acquireRunLease(admission.run.id, { projectId: admission.config.projectId, ownerId: `request:${locals.requestId}` });
		return new Response(createResumeEventStream({ ...body, admittedConfig: admission.config }, { signal: request.signal, lease }), {
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8',
				'cache-control': 'no-store'
			}
		});
	} catch (reason) {
		const status = reason?.status || 500;
		throw error(status, reason?.message || 'Unable to resume run.');
	}
}
