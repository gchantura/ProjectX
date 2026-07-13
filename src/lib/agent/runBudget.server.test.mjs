import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateUsageCost, collectRunUsage, evaluateRunBudget, getProviderPricing } from './runBudget.server.js';

describe('run budget enforcement', () => {
	it('aggregates planning, executor, and verifier usage', () => {
		const run = { summary: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, config: { maxTokensPerRun: 1000, costCeilingUsd: 1 } };
		const steps = [{ providerTrace: { executor: { usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 } }, verifier: { usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } } } }];
		assert.deepEqual(collectRunUsage(run, steps), { inputTokens: 150, outputTokens: 35, totalTokens: 185 });
	});

	it('never reports cloud API spend for local execution', () => {
		assert.equal(calculateUsageCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, {}, 'local-ollama'), 0);
	});
	it('uses provider-specific rates without cross-provider fallback', () => {
		const env = { KCEV_OPENAI_INPUT_USD_PER_MILLION: '5', KCEV_OPENAI_OUTPUT_USD_PER_MILLION: '30', KCEV_ANTHROPIC_INPUT_USD_PER_MILLION: '3', KCEV_ANTHROPIC_OUTPUT_USD_PER_MILLION: '15' };
		assert.equal(calculateUsageCost({ inputTokens: 1_000_000 }, env, 'cloud-openai'), 5);
		assert.equal(calculateUsageCost({ inputTokens: 1_000_000 }, env, 'cloud-anthropic'), 3);
		assert.equal(getProviderPricing('cloud-gemini', env).configured, false);
	});
	it('fails closed when a cost ceiling has no provider pricing', () => {
		const run = { summary: { totalTokens: 10 }, config: { provider: 'cloud-gemini', maxTokensPerRun: 100, costCeilingUsd: 1 } };
		const budget = evaluateRunBudget(run, [], {});
		assert.equal(budget.allowed, false);
		assert.match(budget.reason, /pricing is not configured/);
	});
	it('stops at token and cost boundaries while zero disables a ceiling', () => {
		const tokenRun = { summary: { totalTokens: 100 }, config: { maxTokensPerRun: 100, costCeilingUsd: 0 } };
		assert.equal(evaluateRunBudget(tokenRun).allowed, false);
		assert.match(evaluateRunBudget(tokenRun).reason, /Token ceiling/);
		const costRun = { summary: { inputTokens: 1_000_000, totalTokens: 1_000_000 }, config: { provider: 'cloud-openai', maxTokensPerRun: 0, costCeilingUsd: 1 } };
		assert.equal(evaluateRunBudget(costRun, [], { KCEV_OPENAI_INPUT_USD_PER_MILLION: '5', KCEV_OPENAI_OUTPUT_USD_PER_MILLION: '30' }).allowed, false);
		assert.equal(calculateUsageCost({ inputTokens: 1_000_000 }, { KCEV_OPENAI_INPUT_USD_PER_MILLION: '5', KCEV_OPENAI_OUTPUT_USD_PER_MILLION: '30' }), 5);
	});
});
