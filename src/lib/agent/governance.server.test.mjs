import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateGovernanceReport } from './governance.server.js';

describe('operational governance', () => {
	it('blocks runs when production security or the selected provider is not ready', () => {
		const report = evaluateGovernanceReport({
			now: new Date('2026-07-11T12:00:00.000Z'),
			selectedProviderId: 'cloud-openai',
			diagnostics: fixtureDiagnostics({ securityStatus: 'failed' }),
			providers: [fixtureProvider({ id: 'cloud-openai', ready: false, reliabilityScore: 50 })]
		});
		assert.equal(report.status, 'block');
		assert.equal(report.runGate.canStartRun, false);
		assert.ok(report.checks.some((check) => check.id === 'environment:security' && check.decision === 'block'));
		assert.ok(report.checks.some((check) => check.id === 'providers:cloud-openai' && check.decision === 'block'));
	});

	it('allows with warnings when audit replay or local fallback evidence is incomplete', () => {
		const report = evaluateGovernanceReport({
			selectedProviderId: 'deterministic-local',
			diagnostics: fixtureDiagnostics({ eventStatus: 'warning', localStatus: 'warning' }),
			providers: [fixtureProvider({ id: 'deterministic-local', ready: true, reliabilityScore: 100 })]
		});
		assert.equal(report.status, 'allow_with_warnings');
		assert.equal(report.runGate.canStartRun, true);
		assert.equal(report.summary.warnings, 2);
		assert.match(report.runGate.requiredActions.join('\n'), /Complete one run/);
	});

	it('redacts sensitive diagnostic detail keys', () => {
		const report = evaluateGovernanceReport({
			diagnostics: fixtureDiagnostics({ storageDetails: { backend: 'supabase', serviceRoleKey: 'sensitive-value-should-not-leak' } }),
			providers: [fixtureProvider({ id: 'local-ollama', ready: true })],
			selectedProviderId: 'local-ollama'
		});
		assert.doesNotMatch(JSON.stringify(report), /sensitive-value-should-not-leak/);
		assert.match(JSON.stringify(report), /\[redacted\]/);
	});

	it('blocks explicitly requested providers that are not registered', () => {
		const report = evaluateGovernanceReport({
			selectedProviderId: 'unknown-provider',
			diagnostics: fixtureDiagnostics(),
			providers: [fixtureProvider({ id: 'local-ollama', ready: true })]
		});
		assert.equal(report.status, 'block');
		assert.equal(report.runGate.canStartRun, false);
		assert.match(report.runGate.reason, /unknown-provider/);
		assert.ok(report.checks.some((check) => check.id === 'providers:selected' && check.decision === 'block'));
	});
});

function fixtureDiagnostics({ securityStatus = 'passed', eventStatus = 'passed', localStatus = 'passed', storageDetails = { backend: 'supabase-postgres' } } = {}) {
	return {
		storage: { id: 'storage', status: 'passed', message: 'Run storage is reachable.', details: storageDetails },
		memory: { id: 'memory', status: 'passed', message: 'Memory backend is usable.', details: { backend: 'supabase-postgres' } },
		security: { id: 'security', status: securityStatus, message: securityStatus === 'passed' ? 'Authentication posture is acceptable.' : 'Production requires authentication.', details: { authRequired: securityStatus === 'passed' } },
		events: { id: 'event-log', status: eventStatus, message: eventStatus === 'passed' ? 'Event replay is available.' : 'No persisted event sample exists.', details: { eventCount: eventStatus === 'passed' ? 4 : 0 } },
		localModels: { id: 'local-models', status: localStatus, message: localStatus === 'passed' ? 'Local models detected.' : 'Ollama models were not detected.', details: { count: localStatus === 'passed' ? 2 : 0, models: [] } }
	};
}

function fixtureProvider({ id, ready, reliabilityScore = 100 }) {
	return {
		id,
		name: id,
		ready,
		status: ready ? 'ready' : 'blocked',
		reliabilityScore,
		checkedAt: ready ? '2026-07-11T11:00:00.000Z' : null,
		probeSource: ready ? 'live' : 'not-run',
		nextAction: ready ? 'Provider can execute planned coding runs.' : 'Run capability probes before enabling this provider.'
	};
}
