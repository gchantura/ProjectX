import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateOperationsReport } from './operationsReport.server.js';

describe('operations SLO report', () => {
	it('reports healthy status from verified persisted runs and ready providers', () => {
		const report = evaluateOperationsReport({
			now: new Date('2026-07-11T12:00:00.000Z'),
			runs: [run('run-ok-1', 'verified'), run('run-ok-2', 'verified')],
			providers: [provider('local-ollama', true), provider('cloud-openai', true)],
			diagnostics: { events: { status: 'passed', message: 'Replayable.' } }
		});
		assert.equal(report.status, 'healthy');
		assert.equal(report.metrics.successRate, 1);
		assert.equal(report.metrics.providerReadyRatio, 1);
		assert.equal(report.incidents.length, 0);
		assert.equal(report.metrics.p95DurationMs, 60_000);
	});

	it('raises critical incidents for success and needs-attention SLO breaches', () => {
		const report = evaluateOperationsReport({
			runs: [run('run-ok', 'verified'), run('run-bad-1', 'needs_attention'), run('run-bad-2', 'needs_attention')],
			providers: [provider('local-ollama', true), provider('cloud-openai', false)],
			diagnostics: { events: { status: 'warning', message: 'No event sample.' } },
			slos: { successRate: 0.8, needsAttentionRate: 0.2, providerReadyRatio: 0.5, eventReplayRequired: true }
		});
		assert.equal(report.status, 'critical');
		assert.ok(report.incidents.some((incident) => incident.id === 'slo:success-rate'));
		assert.ok(report.incidents.some((incident) => incident.id === 'slo:needs-attention'));
		assert.ok(report.incidents.some((incident) => incident.id === 'slo:event-replay'));
		assert.equal(report.recentRuns.length, 3);
	});

	it('warns when no completed run evidence exists', () => {
		const report = evaluateOperationsReport({
			runs: [],
			providers: [provider('local-ollama', true)],
			diagnostics: { events: { status: 'passed', message: 'Replayable.' } }
		});
		assert.equal(report.status, 'warning');
		assert.equal(report.metrics.successRate, null);
		assert.ok(report.nextActions.some((action) => /Complete a bounded run/.test(action)));
	});
});

function run(id, status) {
	return {
		id,
		task: `Task for ${id}`,
		status,
		startedAt: '2026-07-11T10:00:00.000Z',
		endedAt: '2026-07-11T10:01:00.000Z',
		config: { provider: 'local-ollama', model: 'ornith:9b' },
		summary: {
			verifiedSteps: status === 'verified' ? 3 : 1,
			failedSteps: status === 'needs_attention' ? 1 : 0,
			estimatedCostUsd: 0.001,
			totalTokens: 100
		}
	};
}

function provider(id, ready) {
	return { id, name: id, ready, nextAction: ready ? 'Ready.' : 'Run probes.' };
}
