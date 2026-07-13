import { error } from '@sveltejs/kit';
import { createApprovedRunEventStream } from '$lib/agent/runStream.server.js';
import { assertResumeAdmission } from '$lib/agent/runAdmission.server.js';
import { acquireRunLease, releaseRunLease } from '$lib/agent/runLease.server.js';
import { consumeRunApproval } from '$lib/agent/runPreflight.server.js';

export async function POST({ request, locals }) {
	try {
		const body = await request.json();
		if (!body.preflightRunId) throw Object.assign(new Error('Create and approve a preflight plan before execution.'), { status: 428, code: 'RUN_PREFLIGHT_REQUIRED' });
		const admission = await assertResumeAdmission({ runId: body.preflightRunId });
		const lease = await acquireRunLease(admission.run.id, { projectId: admission.config.projectId, ownerId: `request:${locals.requestId}` });
		let approval;
		try {
			approval = await consumeRunApproval(admission.run, body.approvalToken, { actor: locals.identity?.subject });
		} catch (reason) {
			await releaseRunLease(lease).catch(() => undefined);
			throw reason;
		}
		return new Response(createApprovedRunEventStream({ ...body, admittedConfig: admission.config }, { signal: request.signal, lease, run: admission.run, approval }), {
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8',
				'cache-control': 'no-store'
			}
		});
	} catch (reason) {
		const status = reason?.status || 500;
		throw error(status, reason?.message || 'Unable to stream run.');
	}
}
