import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runMaintenanceAutomation } from './automation.server.js';

describe('maintenance automation', () => {
	it('probes stale providers and returns a redacted operational report', async () => {
		const report = await runMaintenanceAutomation(
			{ staleAfterMinutes: 60 },
			{
				now: new Date('2026-07-11T12:00:00.000Z'),
				collectDiagnostics: async ({ now }) => diagnostics(now, { warnings: 0, failed: 0 }),
				listProviderReadiness: async () => [
					{ id: 'cloud-openai', status: 'blocked', checkedAt: '2026-07-10T10:00:00.000Z' },
					{ id: 'local-ollama', status: 'ready', checkedAt: '2026-07-11T11:55:00.000Z' }
				],
				runProviderReadinessProbe: async (id) => ({ id, status: 'ready', ready: true, reliabilityScore: 100, nextAction: 'Provider can execute planned coding runs.' })
			}
		);
		assert.equal(report.status, 'completed');
		assert.deepEqual(report.probes.map((probe) => probe.providerId), ['cloud-openai']);
		assert.match(report.id, /^maintenance-/);
		assert.doesNotMatch(JSON.stringify(report), /secret|authorization|bearer/i);
	});

	it('reports probe failures without aborting the maintenance run', async () => {
		const report = await runMaintenanceAutomation(
			{ probeProviders: true },
			{
				now: new Date('2026-07-11T12:00:00.000Z'),
				collectDiagnostics: async ({ now }) => diagnostics(now, { warnings: 1, failed: 0 }),
				listProviderReadiness: async () => [{ id: 'cloud-xai', status: 'blocked', checkedAt: null }],
				runProviderReadinessProbe: async () => { throw new Error('invalid credential'); }
			}
		);
		assert.equal(report.status, 'completed_with_warnings');
		assert.equal(report.probes[0].status, 'failed');
		assert.match(report.nextActions.join(' '), /provider/i);
	});
});

function diagnostics(now, { warnings, failed }) {
	return {
		status: failed > 0 ? 'degraded' : 'ready',
		checkedAt: now.toISOString(),
		summary: { ready: failed === 0, passed: 8, warnings, failed, total: 8 + warnings + failed },
		storage: { status: 'passed' },
		memory: { status: 'passed' },
		security: { status: 'passed' },
		events: { status: 'passed' },
		localModels: { status: 'passed' },
		providers: { readyCount: 1, total: 2 }
	};
}
