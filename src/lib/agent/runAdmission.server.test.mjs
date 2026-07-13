import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertResumeAdmission, assertRunAdmission } from './runAdmission.server.js';

const collectReadyProject = async () => ({ status: 'ready', blockers: [], warnings: [] });

describe('run admission control', () => {
	it('rejects blocked governance before a run stream is opened', async () => {
		await assert.rejects(
			() => assertRunAdmission(
				{ config: { provider: 'cloud-openai' } },
				{
					collectReadiness: collectReadyProject,
					normalizeConfig: async () => ({ provider: 'cloud-openai' }),
					collectGovernance: async () => ({
						status: 'block',
						runGate: { canStartRun: false, reason: 'Selected provider is blocked.', requiredActions: ['Run provider probes.'] },
						checks: []
					})
				}
			),
			(error) => {
				assert.equal(error.status, 409);
				assert.equal(error.code, 'RUN_GOVERNANCE_BLOCKED');
				assert.equal(error.governance.runGate.requiredActions[0], 'Run provider probes.');
				return true;
			}
		);
	});

	it('returns normalized config and governance evidence when admission passes', async () => {
		const result = await assertRunAdmission(
			{ config: { provider: 'local-ollama' } },
			{
				collectReadiness: collectReadyProject,
				normalizeConfig: async () => ({ provider: 'local-ollama', model: 'ornith:9b' }),
				collectGovernance: async ({ selectedProviderId }) => ({
					status: 'allow',
					selectedProvider: { id: selectedProviderId },
					runGate: { canStartRun: true, reason: 'ok', requiredActions: [] },
					checks: []
				})
			}
		);
		assert.equal(result.config.model, 'ornith:9b');
		assert.equal(result.governance.selectedProvider.id, 'local-ollama');
		assert.match(result.executionContext.signature, /^[a-f0-9]{64}$/);
	});

	it('rejects budgeted cloud execution without provider-specific pricing', async () => {
		await assert.rejects(() => assertRunAdmission({ config: {} }, {
			collectReadiness: collectReadyProject,
			normalizeConfig: async () => ({ provider: 'cloud-gemini', model: 'gemini-test', costCeilingUsd: 1 }),
			collectGovernance: async () => ({ status: 'allow', runGate: { canStartRun: true, reason: 'ok', requiredActions: [] }, checks: [] }),
			getPricing: () => ({ configured: false })
		}), (error) => error.status === 409 && error.code === 'RUN_PRICING_UNCONFIGURED');
	});

	it('reapplies governance and pricing admission before resume', async () => {
		const calls = [];
		const result = await assertResumeAdmission({ runId: 'run-resume' }, {
			collectReadiness: collectReadyProject,
			getRun: async () => ({ id: 'run-resume', config: { provider: 'cloud-anthropic', model: 'claude-test', costCeilingUsd: 2, executionContext: { version: 1 } } }),
			normalizeConfig: async (config) => config,
			validateContext: () => ({ valid: true }),
			collectGovernance: async (input) => { calls.push(input); return { status: 'allow', runGate: { canStartRun: true, reason: 'ok', requiredActions: [] }, checks: [] }; },
			getPricing: () => ({ configured: true })
		});
		assert.equal(result.run.id, 'run-resume');
		assert.equal(calls[0].selectedModel, 'claude-test');
	});

	it('rejects resume when the persisted execution context no longer validates', async () => {
		await assert.rejects(() => assertResumeAdmission({ runId: 'run-drifted' }, {
			getRun: async () => ({ id: 'run-drifted', config: { provider: 'local-ollama', executionContext: { version: 1 } } }),
			normalizeConfig: async (config) => config,
			collectReadiness: collectReadyProject,
			collectGovernance: async () => ({ status: 'allow', runGate: { canStartRun: true, reason: 'ok', requiredActions: [] }, checks: [] }),
			validateContext: () => ({ valid: false, reason: 'Project policy changed after this run was admitted.' })
		}), (error) => error.code === 'RUN_CONTEXT_INVALID' && /policy changed/i.test(error.message));
	});

	it('persists the requested autonomy mode in the admitted config', async () => {
		let normalizedInput;
		const result = await assertRunAdmission({ mode: 'analyze', config: { projectId: 'project-safe' } }, {
			collectReadiness: collectReadyProject,
			normalizeConfig: async (input) => { normalizedInput = input; return { ...input, provider: 'local-ollama', model: 'ornith:9b' }; },
			collectGovernance: async () => ({ status: 'allow', runGate: { canStartRun: true, reason: 'ok', requiredActions: [] }, checks: [] })
		});
		assert.equal(normalizedInput.autonomyMode, 'analyze');
		assert.equal(result.config.autonomyMode, 'analyze');
	});

	it('blocks new and resumed execution when project readiness is blocked', async () => {
		const collectReadiness = async () => ({ status: 'blocked', blockers: ['No quality gates are configured.'], warnings: [] });
		await assert.rejects(() => assertRunAdmission({ config: {} }, {
			normalizeConfig: async () => ({ projectId: 'project-blocked', provider: 'local-ollama' }),
			collectReadiness
		}), (error) => error.code === 'RUN_PROJECT_BLOCKED' && error.readiness.blockers.length === 1);
		await assert.rejects(() => assertResumeAdmission({ runId: 'run-blocked' }, {
			getRun: async () => ({ id: 'run-blocked', config: { projectId: 'project-blocked', provider: 'local-ollama' } }),
			normalizeConfig: async (config) => config,
			collectReadiness
		}), (error) => error.code === 'RUN_PROJECT_BLOCKED');
	});
});
