import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clearStoredRunsForTest, getRunEvents, getStoredRun, listStoredRuns, persistRun } from './runStore.server.js';
import { streamResumeEvents, streamRunEvents } from './runStream.server.js';
import { prometheusMetrics } from '../server/telemetry.js';

const failureFixture = 'docs/retry-failure-fixture.md';
let storeDir;

test.before(async () => {
	storeDir = await mkdtemp(join(tmpdir(), 'kcevagent-stream-'));
	process.env.KCEV_AGENT_DATA_DIR = storeDir;
});

test.beforeEach(async () => {
	await clearStoredRunsForTest();
	await rm(failureFixture, { force: true });
});

test.afterEach(async () => {
	await rm(failureFixture, { force: true });
});

test.after(async () => {
	delete process.env.KCEV_AGENT_DATA_DIR;
	await rm(storeDir, { force: true, recursive: true });
});

test('streams run lifecycle events and persists the final run', async () => {
	const events = [];

	for await (const event of streamRunEvents({
		task: 'Build UI streaming dashboard',
		config: { stepCeiling: 3 }
	})) {
		events.push(event);
	}

	assert.equal(events[0].type, 'run_started');
	assert.ok(events.some((event) => event.type === 'step_started'));
	assert.ok(events.some((event) => event.type === 'step_completed'));
	assert.equal(events.at(-1).type, 'run_completed');
	assert.match(events.at(-1).run.endedAt, /^\d{4}-\d{2}-\d{2}T/);
	assert.equal(events.at(-1).run.summary.failedSteps, 0);

	const stored = await listStoredRuns();
	assert.equal(stored.length, 1);
	assert.equal(stored[0].id, events.at(-1).run.id);
	assert.deepEqual((await getRunEvents(stored[0].id)).map((event) => event.type), events.map((event) => event.type));
	const metrics = prometheusMetrics();
	assert.match(metrics, /kcev_agent_runs_total\{operation="new",provider="deterministic-local",status="verified"\}/);
	assert.match(metrics, /kcev_agent_run_duration_ms_count\{operation="new",provider="deterministic-local",status="verified"\}/);
});

test('streams a provider-backed planner, executor, and verifier run', async () => {
	const provider = fixtureCloudProvider();
	const events = [];

	for await (const event of streamRunEvents(
		{ task: 'Inspect the project map', config: { provider: 'cloud-openai', stepCeiling: 2 } },
		{ provider }
	)) events.push(event);

	const finalRun = events.at(-1).run;
	assert.equal(events[0].type, 'run_started');
	assert.equal(finalRun.config.model, 'gpt-5.5');
	assert.equal(finalRun.status, 'verified');
	assert.equal(finalRun.steps[0].tool, 'inspect_context');
	assert.equal(finalRun.summary.totalTokens, 60);
	assert.ok(finalRun.steps[0].verification.evidence.includes('verifier:approved'));
	assert.equal((await getStoredRun(finalRun.id)).providerTrace.adjudicator.model, 'gpt-5.5');
});

test('persists a stopped run when the stream is aborted', async () => {
	const controller = new AbortController();
	const events = [];

	for await (const event of streamRunEvents(
		{
			task: 'Build UI streaming dashboard',
			config: { stepCeiling: 3 }
		},
		{ signal: controller.signal }
	)) {
		events.push(event);
		if (event.type === 'run_started') controller.abort();
	}

	assert.equal(events.at(-1).type, 'run_stopped');
	assert.equal(events.at(-1).run.status, 'stopped');
	assert.match(events.at(-1).run.endedAt, /^\d{4}-\d{2}-\d{2}T/);

	const stored = await listStoredRuns();
	assert.equal(stored.length, 1);
	assert.equal(stored[0].status, 'stopped');
});

test('retries a failed step once and escalates after repeated verifier failure', async () => {
	const events = [];

	for await (const event of streamRunEvents(
		{
			task: 'Build UI streaming dashboard',
			config: { stepCeiling: 4 }
		},
		{ materializeStep: failValidationStep }
	)) {
		events.push(event);
	}

	const retryEvents = events.filter((event) => event.type === 'step_retrying');
	const escalation = events.find((event) => event.type === 'step_escalated');
	const finalRun = events.at(-1).run;
	const failedStep = finalRun.steps.find((step) => step.status === 'failed');

	assert.equal(retryEvents.length, 1);
	assert.equal(escalation.step.id, 'verify-1');
	assert.equal(finalRun.status, 'needs_attention');
	assert.ok(failedStep.verification.evidence.includes('retry:exhausted'));
	assert.ok(failedStep.verification.evidence.includes('escalation:user-required'));

	const stored = await listStoredRuns();
	assert.equal(stored[0].status, 'needs_attention');
});

test('releases durable ownership when execution throws unexpectedly', async () => {
	let releases = 0;
	const leaseStore = {
		async claim({ projectId, runId, ownerId }) { return { acquired: true, projectId, runId, ownerId, leaseToken: '00000000-0000-4000-8000-000000000099', expiresAt: '2099-01-01T00:00:00.000Z', attempt: 1 }; },
		async heartbeat({ runId }) { return { renewed: true, runId, expiresAt: '2099-01-01T00:00:00.000Z', attempt: 1 }; },
		async release() { releases += 1; return true; }
	};
	await assert.rejects(() => collectEvents(streamRunEvents(
		{ task: 'Exercise lease cleanup', config: { stepCeiling: 1 } },
		{ leaseStore, materializeStep: async () => { throw new Error('Injected worker crash.'); } }
	)), /Injected worker crash/);
	assert.equal(releases, 1);
});

test('resumes a stopped run from the first unverified step', async () => {
	const stoppedEvents = [];
	const controller = new AbortController();

	for await (const event of streamRunEvents(
		{
			task: 'Build UI streaming dashboard',
			config: { stepCeiling: 2 }
		},
		{ signal: controller.signal }
	)) {
		stoppedEvents.push(event);
		if (event.type === 'step_completed' && event.step.id === 'plan-1') controller.abort();
	}

	const stoppedRun = stoppedEvents.at(-1).run;
	const resumedEvents = [];

	for await (const event of streamResumeEvents({ runId: stoppedRun.id })) {
		resumedEvents.push(event);
	}

	const resumeEvent = resumedEvents[0];
	const startedStepIds = resumedEvents
		.filter((event) => event.type === 'step_started')
		.map((event) => event.step.id);
	const finalRun = resumedEvents.at(-1).run;
	const stored = await getStoredRun(stoppedRun.id);
	const persistedEvents = await getRunEvents(stoppedRun.id);

	assert.equal(resumeEvent.type, 'run_resumed');
	assert.equal(resumeEvent.resume.skippedVerifiedSteps, 1);
	assert.equal(startedStepIds.includes('plan-1'), false);
	assert.equal(startedStepIds[0], 'exec-1');
	assert.equal(finalRun.id, stoppedRun.id);
	assert.equal(finalRun.status, 'verified');
	assert.equal(stored.status, 'verified');
	assert.equal(stored.summary.remainingSteps, 0);
	assert.ok(persistedEvents.some((event) => event.type === 'run_stopped'));
	assert.ok(persistedEvents.some((event) => event.type === 'run_resumed'));
	assert.equal(persistedEvents.at(-1).type, 'run_completed');
});

test('resumes a needs-attention run by replaying the failed step', async () => {
	const run = buildStoredRunWithFailedStep();
	await persistRun(run);

	const events = [];
	for await (const event of streamResumeEvents({ runId: run.id }, { materializeStep: passAllSteps })) {
		events.push(event);
	}

	const startedStepIds = events
		.filter((event) => event.type === 'step_started')
		.map((event) => event.step.id);

	assert.deepEqual(startedStepIds, ['verify-1']);
	assert.equal(events.at(-1).run.status, 'verified');
	assert.equal(events.at(-1).run.summary.verifiedSteps, 3);
});

test('resumes a model-backed run with its persisted provider and verifier', async () => {
	const run = buildStoredModelRun();
	await persistRun(run);
	const provider = {
		async completeStructured() {
			return { value: { verified: true, reason: 'Persisted provider verified the workspace evidence.', evidence_checked: ['file:PROJECT_MAP.md'] }, providerResponseId: 'resp_resume', requestId: 'req_resume', model: 'gpt-5.5', attempts: 1, usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } };
		}
	};
	const events = await collectEvents(streamResumeEvents({ runId: run.id }, { provider }));
	const finalRun = events.at(-1).run;
	assert.equal(finalRun.status, 'verified');
	assert.equal(finalRun.steps[0].providerTrace.verifier.requestId, 'req_resume');
	assert.equal(finalRun.steps[0].providerTrace.verifier.model, 'gpt-5.5');
	assert.ok(finalRun.steps[0].verification.evidence.includes('verifier:approved'));
});

test('rejects resume requests for missing run ids', async () => {
	await assert.rejects(() => collectEvents(streamResumeEvents({ runId: 'run-missing' })), /Run not found/);
});

async function failValidationStep(step) {
	if (step.id !== 'verify-1') {
		return {
			...step,
			status: 'verified',
			rawOutput: `test materialized ${step.id}`,
			verification: {
				...step.verification,
				verified: true,
				evidence: [...step.verification.evidence, 'test:materialized']
			}
		};
	}

	return {
		...step,
		status: 'failed',
		rawOutput: 'Injected verifier failure.',
		verification: {
			...step.verification,
			verified: false,
			reason: 'Injected verifier failure.',
			evidence: [...step.verification.evidence, 'test:failure']
		}
	};
}

async function passAllSteps(step) {
	return {
		...step,
		status: 'verified',
		rawOutput: `resumed ${step.id}`,
		verification: {
			...step.verification,
			verified: true,
			reason: 'Resumed step passed.',
			evidence: [...step.verification.evidence, 'test:resumed']
		}
	};
}

async function collectEvents(events) {
	const collected = [];
	for await (const event of events) collected.push(event);
	return collected;
}

function buildStoredRunWithFailedStep() {
	const base = {
		id: 'run-resume-failed-test',
		task: 'Resume failed verifier step',
		status: 'needs_attention',
		config: {
			projectId: 'project-test-default',
			projectName: 'Test project',
			provider: 'deterministic-local',
			model: 'kcev-sim-1',
			domain: 'coding',
			stepCeiling: 3,
			workspaceScope: 'current project',
			costCeilingUsd: 0
		},
		startedAt: new Date('2026-07-10T12:00:00.000Z').toISOString(),
		summary: {
			totalSteps: 3,
			verifiedSteps: 2,
			failedSteps: 1,
			remainingSteps: 0,
			estimatedCostUsd: 0
		},
		guardrails: [],
		nextActions: ['Resume from the last verified step']
	};
	const steps = [
		storedStep('plan-1', 'planner', 'Decompose objective', 'inspect_context', 'verified'),
		storedStep('exec-1', 'executor', 'Prepare coding module', 'write_artifact', 'verified'),
		storedStep('verify-1', 'verifier', 'Verify first slice', 'run_validation', 'failed')
	];

	return { ...base, steps };
}

function buildStoredModelRun() {
	return {
		id: 'run-resume-model-test', task: 'Resume model-backed inspection', status: 'stopped',
		config: { projectId: 'project-test-default', projectName: 'Test project', provider: 'cloud-openai', model: 'gpt-5.5', domain: 'coding', stepCeiling: 1, workspaceScope: 'current project', costCeilingUsd: 0 },
		startedAt: new Date('2026-07-10T12:00:00.000Z').toISOString(),
		summary: { totalSteps: 1, verifiedSteps: 0, failedSteps: 0, remainingSteps: 1, estimatedCostUsd: 0 },
		guardrails: [], nextActions: ['Resume from persisted ledger'],
		steps: [{ ...storedStep('inspect-1', 'executor', 'Inspect project map', 'inspect_context', 'stopped'), status: 'stopped' }]
	};
}

function fixtureCloudProvider() {
	let call = 0;
	return {
		async completeStructured() {
			call += 1;
			const plan = { steps: [{ id: 'inspect-map', title: 'Inspect map', description: 'Read the project map as evidence.', tool: 'inspect_context', arguments_json: '{"path":"PROJECT_MAP.md"}', depends_on: [], risk: 'low', evidence_required: 'Project map file contents.' }] };
			const value = call <= 2
				? plan
				: call === 3
					? { selected_candidate: 'candidate_b', rationale: 'Equivalent evidence with maximum leverage.', strengths: ['bounded read'], risks: [] }
					: { verified: true, reason: 'The raw file content proves the map was read.', evidence_checked: ['file:PROJECT_MAP.md'] };
			return { value, providerResponseId: `resp_${call}`, requestId: `req_${call}`, model: 'gpt-5.5', attempts: 1, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
		}
	};
}

function storedStep(id, role, title, tool, status) {
	return {
		id,
		role,
		title,
		description: `${title} description`,
		tool,
		risk: tool === 'inspect_context' ? 'low' : 'medium',
		status,
		startedAtOffsetMs: 0,
		durationMs: 1,
		toolCall: tool === 'run_validation'
			? { name: tool, args: { command: 'npm run ai:check', timeoutMs: 30000 } }
			: { name: tool, args: { path: tool === 'inspect_context' ? 'PROJECT_MAP.md' : '.kcevagent/artifacts/test.md', content: '# test' } },
		rawOutput: status === 'failed' ? 'failed before resume' : `verified ${id}`,
		verification: {
			verified: status === 'verified',
			reason: status === 'verified' ? 'Previously verified.' : 'Previously failed.',
			evidence: [`tool:${tool}`, status === 'verified' ? 'test:verified-prefix' : 'test:failed-step']
		}
	};
}
