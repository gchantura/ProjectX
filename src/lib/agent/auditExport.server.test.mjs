import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createRunAuditBundle } from './auditExport.server.js';
import { clearStoredRunsForTest, persistRun, persistRunEvents } from './runStore.server.js';

let storeDir;
let originalDir;

beforeEach(async () => {
	storeDir = await mkdtemp(join(tmpdir(), 'kcevagent-audit-export-'));
	originalDir = process.env.KCEV_AGENT_DATA_DIR;
	process.env.KCEV_AGENT_DATA_DIR = storeDir;
	await clearStoredRunsForTest();
});

afterEach(async () => {
	if (originalDir === undefined) delete process.env.KCEV_AGENT_DATA_DIR;
	else process.env.KCEV_AGENT_DATA_DIR = originalDir;
	await rm(storeDir, { force: true, recursive: true });
});

describe('run audit export', () => {
	it('builds a deterministic evidence bundle with component hashes', async () => {
		const run = fixtureRun();
		await persistRun(run);
		await persistRunEvents(run.id, [{ position: 0, type: 'run_completed', payload: { type: 'run_completed', runId: run.id }, createdAt: '2026-07-11T10:00:00.000Z' }]);
		const bundle = await createRunAuditBundle(run.id, {
			now: new Date('2026-07-11T12:00:00.000Z'),
			diagnostics: { ollamaProvider: { listModels: async () => [] } }
		});
		assert.equal(bundle.manifest.runId, run.id);
		assert.match(bundle.manifest.bundleSha256, /^[a-f0-9]{64}$/);
		assert.match(bundle.manifest.componentHashes.run, /^[a-f0-9]{64}$/);
		assert.match(bundle.manifest.componentHashes.executionContext, /^[a-f0-9]{64}$/);
		assert.match(bundle.manifest.componentHashes.approvals, /^[a-f0-9]{64}$/);
		assert.equal(bundle.events.length, 1);
		assert.equal(bundle.graph.summary.totalNodes, 1);
		assert.doesNotMatch(JSON.stringify(bundle), /server-secret|bearer/i);
	});

	it('returns undefined for a missing run', async () => {
		assert.equal(await createRunAuditBundle('run-missing'), undefined);
	});
});

function fixtureRun() {
	return {
		id: 'run-audit-export-test',
		task: 'Export audit evidence',
		status: 'verified',
		startedAt: '2026-07-11T10:00:00.000Z',
		endedAt: '2026-07-11T10:01:00.000Z',
		config: { provider: 'deterministic-local', model: 'kcev-sim-1', domain: 'coding', stepCeiling: 1, costCeilingUsd: 0 },
		summary: { totalSteps: 1, verifiedSteps: 1, failedSteps: 0, remainingSteps: 0, estimatedCostUsd: 0 },
		steps: [{ id: 'inspect', role: 'executor', title: 'Inspect', description: 'Inspect context', status: 'verified', risk: 'low', tool: 'inspect_context', toolCall: { name: 'inspect_context', args: { path: 'PROJECT_MAP.md' } }, rawOutput: 'ok', verification: { verified: true, reason: 'ok', evidence: ['file:PROJECT_MAP.md'] } }],
		guardrails: [],
		nextActions: []
	};
}
