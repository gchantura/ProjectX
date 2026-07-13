import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import {
	buildLedgerFromRun,
	clearStoredRunsForTest,
	createStoredRun,
	getRunEvents,
	getRunLedger,
	getStoredRun,
	listStoredRuns,
	persistRunEvents
} from './runStore.server.js';

let storeDir;

before(async () => {
	storeDir = await mkdtemp(join(tmpdir(), 'kcevagent-runs-'));
	process.env.KCEV_AGENT_DATA_DIR = storeDir;
	await clearStoredRunsForTest();
});

after(async () => {
	delete process.env.KCEV_AGENT_DATA_DIR;
	await rm(storeDir, { force: true, recursive: true });
});

test('creates and reads a persisted run', async () => {
	const run = await createStoredRun({
		task: 'Persist a planner executor verifier run',
		config: { stepCeiling: 3 }
	});

	assert.match(run.id, /^run-/);
	assert.equal(run.summary.totalSteps, 3);
	assert.match(run.steps[0].rawOutput, /Project Map/);
	assert.ok(run.steps[0].verification.evidence.includes('file:PROJECT_MAP.md'));

	const found = await getStoredRun(run.id);
	assert.equal(found.id, run.id);
	assert.equal(found.task, run.task);
});

test('persists normalized ledger records for run audit', async () => {
	const run = await createStoredRun({
		task: 'Persist normalized ledger records',
		config: { stepCeiling: 3 }
	});
	const ledger = await getRunLedger(run.id);

	assert.equal(ledger.run.id, run.id);
	assert.equal(ledger.steps.length, run.steps.length);
	assert.equal(ledger.toolCalls.length, run.steps.length);
	assert.equal(ledger.verifications.length, run.steps.length);
	assert.ok(ledger.artifacts.some((artifact) => artifact.path.startsWith('.kcevagent/artifacts/')));
	assert.deepEqual(ledger.toolCalls[0].args, run.steps[0].toolCall.args);
	assert.deepEqual(ledger.verifications[0].evidence, run.steps[0].verification.evidence);
});

test('persists run events without losing them during run updates', async () => {
	const run = await createStoredRun({
		task: 'Persist event history',
		config: { stepCeiling: 2 }
	});
	await persistRunEvents(run.id, [
		{ position: 0, type: 'run_started', payload: { type: 'run_started', runId: run.id }, createdAt: '2026-07-11T10:00:00.000Z' },
		{ position: 1, type: 'run_completed', payload: { type: 'run_completed', runId: run.id }, createdAt: '2026-07-11T10:00:01.000Z' }
	]);
	await createStoredRun({ task: 'Another run for churn' });
	const events = await getRunEvents(run.id);
	assert.deepEqual(events.map((event) => event.type), ['run_started', 'run_completed']);
	assert.equal(events[0].payload.runId, run.id);
});

test('derives a ledger from a stored run document for remote backends', () => {
	const run = {
		id: 'run-remote-ledger',
		task: 'Persist remotely',
		status: 'verified',
		startedAt: '2026-07-11T10:00:00.000Z',
		endedAt: '2026-07-11T10:00:01.000Z',
		config: { provider: 'cloud-gemini', model: 'gemini-3.5-flash', domain: 'coding', stepCeiling: 2, costCeilingUsd: 1 },
		summary: { totalSteps: 1, verifiedSteps: 1, failedSteps: 0, remainingSteps: 0, estimatedCostUsd: 0.01 },
		steps: [{
			id: 'write',
			role: 'executor',
			title: 'Write',
			description: 'Write artifact',
			status: 'verified',
			risk: 'low',
			tool: 'write_artifact',
			toolCall: { name: 'write_artifact', args: { path: '.kcevagent/artifacts/remote.md' } },
			rawOutput: 'ok',
			verification: { verified: true, reason: 'Artifact exists.', evidence: ['artifact:.kcevagent/artifacts/remote.md'] }
		}]
	};

	const ledger = buildLedgerFromRun(run);
	assert.equal(ledger.run.provider, 'cloud-gemini');
	assert.equal(ledger.steps[0].step_id, 'write');
	assert.equal(ledger.toolCalls[0].args.path, '.kcevagent/artifacts/remote.md');
	assert.equal(ledger.verifications[0].verified, true);
	assert.equal(ledger.artifacts[0].path, '.kcevagent/artifacts/remote.md');
});

test('lists newest runs first', async () => {
	const first = await createStoredRun({ task: 'First stored run' });
	const second = await createStoredRun({ task: 'Second stored run' });
	const runs = await listStoredRuns({ limit: 2 });

	assert.equal(runs.length, 2);
	assert.equal(runs[0].id, second.id);
	assert.equal(runs[1].id, first.id);
});

test('rejects empty tasks before persistence', async () => {
	await assert.rejects(() => createStoredRun({ task: '   ' }), /Task is required/);
});
