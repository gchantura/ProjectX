import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { clearSupabaseTestState, createSupabaseApprovalStore } from './supabaseStore.server.js';
import { consumeRunApproval, createRunPreflight, rejectRunPreflight, validateApprovalToken } from './runPreflight.server.js';
import { getRunEvents, getStoredRun } from './runStore.server.js';
import { streamApprovedRunEvents } from './runStream.server.js';

beforeEach(() => clearSupabaseTestState());

test('persists an exact reviewable plan and stores only a one-time approval-token hash', async () => {
	const result = await createRunPreflight({ task: 'Build a focused UI workflow', config: fixtureConfig() }, { now: new Date('2026-07-13T00:00:00.000Z') });
	assert.equal(result.run.status, 'awaiting_approval');
	assert.ok(result.run.steps.every((step) => step.status === 'planned' && step.rawOutput === ''));
	assert.match(result.run.preflight.planSha256, /^[a-f0-9]{64}$/);
	assert.match(result.approvalToken, /^[a-zA-Z0-9_-]{40,128}$/);
	assert.doesNotMatch(JSON.stringify(await getStoredRun(result.run.id)), new RegExp(result.approvalToken));
	assert.equal((await getRunEvents(result.run.id))[0].type, 'preflight_created');
});

test('rejects plan tampering, expiry, and approval replay', async () => {
	const now = new Date('2026-07-13T00:00:00.000Z');
	const store = createSupabaseApprovalStore();
	const result = await createRunPreflight({ task: 'Inspect the project architecture', config: fixtureConfig() }, { now, approvalStore: store });
	const tampered = structuredClone(result.run);
	tampered.steps[0].toolCall.args.path = 'docs/other.md';
	assert.throws(() => validateApprovalToken(tampered, result.approvalToken, now), (error) => error.code === 'RUN_PLAN_TAMPERED');
	assert.throws(() => validateApprovalToken(result.run, result.approvalToken, new Date('2026-07-13T00:31:00.000Z')), (error) => error.code === 'RUN_APPROVAL_EXPIRED');
	const approval = await consumeRunApproval(result.run, result.approvalToken, { actor: 'operator', approvalStore: store, now: new Date('2026-07-13T00:01:00.000Z') });
	assert.equal(approval.decision, 'approved');
	await assert.rejects(() => consumeRunApproval(result.run, result.approvalToken, { actor: 'operator', approvalStore: store, now: new Date('2026-07-13T00:02:00.000Z') }), (error) => error.code === 'RUN_APPROVAL_UNAVAILABLE');
});

test('executes the exact approved plan without replanning', async () => {
	const store = createSupabaseApprovalStore();
	const result = await createRunPreflight({ task: 'Build UI workflow', config: fixtureConfig() }, { approvalStore: store });
	const approval = await consumeRunApproval(result.run, result.approvalToken, { actor: 'operator', approvalStore: store });
	const plannedIds = result.run.steps.map((step) => step.id);
	const executedIds = [];
	const events = [];
	for await (const event of streamApprovedRunEvents({ preflightRunId: result.run.id }, {
		run: result.run,
		approval,
		materializeStep: async (step) => {
			executedIds.push(step.id);
			return { ...step, status: 'verified', rawOutput: `verified ${step.id}`, verification: { ...step.verification, verified: true, reason: 'Test evidence verified.', evidence: [...step.verification.evidence, 'test:approved-plan'] } };
		}
	})) events.push(event);
	assert.deepEqual(executedIds, plannedIds);
	assert.equal(events[0].type, 'run_started');
	assert.equal(events[0].run.preflight.planSha256, result.run.preflight.planSha256);
	assert.equal(events.at(-1).run.status, 'verified');
});

test('durably rejects a discarded plan and records the decision', async () => {
	const store = createSupabaseApprovalStore();
	const result = await createRunPreflight({ task: 'Review and discard this plan', config: fixtureConfig() }, { approvalStore: store });
	const rejected = await rejectRunPreflight(result.run, { actor: 'operator', approvalStore: store, now: new Date('2026-07-13T00:05:00.000Z') });
	assert.equal(rejected.run.status, 'stopped');
	assert.equal(rejected.run.preflight.status, 'rejected');
	assert.equal(rejected.approval.decision, 'rejected');
	assert.equal((await getRunEvents(result.run.id)).at(-1).type, 'preflight_rejected');
	await assert.rejects(() => consumeRunApproval(result.run, result.approvalToken, { actor: 'operator', approvalStore: store }), (error) => error.code === 'RUN_APPROVAL_UNAVAILABLE');
});

function fixtureConfig() {
	return {
		projectId: 'project-test-default', projectName: 'Test project', workspaceRoot: process.cwd(),
		provider: 'deterministic-local', model: 'kcev-sim-1', domain: 'coding', autonomyMode: 'execute',
		stepCeiling: 4, costCeilingUsd: 0, maxTokensPerRun: 100000,
		allowedPaths: ['src/', 'docs/', 'PROJECT_MAP.md'], networkAllowlist: [], requireApprovalForSourceWrites: true,
		executionContext: { actor: 'operator', correlationId: 'request-preflight-test', signature: 'a'.repeat(64) }
	};
}
