import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
	getProviderProbePath,
	readProviderProbeCache,
	runProviderCapabilityProbes
} from './providerProbeStore.server.js';

let storeDir;
let originalEnv;

beforeEach(async () => {
	storeDir = await mkdtemp(join(tmpdir(), 'kcevagent-probes-'));
	process.env.KCEV_AGENT_DATA_DIR = storeDir;
	originalEnv = {
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		GEMINI_API_KEY: process.env.GEMINI_API_KEY,
		GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
		XAI_API_KEY: process.env.XAI_API_KEY
	};
	delete process.env.OPENAI_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.GEMINI_API_KEY;
	delete process.env.GOOGLE_API_KEY;
	delete process.env.XAI_API_KEY;
});

afterEach(async () => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	delete process.env.KCEV_AGENT_DATA_DIR;
	await rm(storeDir, { force: true, recursive: true });
});

describe('provider probe store', () => {
	it('persists deterministic local capability probes', async () => {
		const record = await runProviderCapabilityProbes(
			'deterministic-local',
			new Date('2026-07-10T12:00:00.000Z')
		);
		const cache = await readProviderProbeCache();
		const raw = JSON.parse(await readFile(getProviderProbePath(), 'utf8'));

		assert.equal(record.checkedAt, '2026-07-10T12:00:00.000Z');
		assert.equal(record.capabilities.nativeToolCalling, true);
		assert.equal(record.probes.every((probe) => probe.passed), true);
		assert.deepEqual(cache['deterministic-local'].probes, raw['deterministic-local'].probes);
	});

	it('does not mark cloud execution ready from credentials alone', async () => {
		process.env.OPENAI_API_KEY = 'test-key';

		const record = await runProviderCapabilityProbes(
			'cloud-openai',
			new Date('2026-07-10T12:00:00.000Z'),
			{ openAIProvider: { completeStructured: async () => { throw new Error('invalid credential'); } } }
		);

		assert.equal(record.capabilities.nativeToolCalling, false);
		assert.equal(record.probes.find((probe) => probe.id === 'api-key').passed, true);
		assert.equal(record.probes.find((probe) => probe.id === 'structured-output').passed, false);
	});

	it('marks cloud structured execution ready only after a live response', async () => {
		const record = await runProviderCapabilityProbes('cloud-openai', new Date('2026-07-10T12:00:00.000Z'), {
			openAIProvider: { completeStructured: async () => ({ value: { ready: true }, usage: { totalTokens: 4 } }) }
		});
		assert.equal(record.source, 'live-responses-api');
		assert.equal(record.capabilities.jsonMode, true);
		assert.equal(record.probes.every((probe) => probe.passed), true);
	});

	it('probes local OpenAI-compatible runtimes with the same live structured contract', async () => {
		const record = await runProviderCapabilityProbes('local-openai-compatible', new Date('2026-07-10T12:00:00.000Z'), {
			localOpenAIProvider: {
				listModels: async () => [{ name: 'lmstudio:test' }],
				completeStructured: async ({ model }) => ({ value: { ready: true }, model, usage: { totalTokens: 9 } })
			}
		});
		assert.equal(record.source, 'live-local-openai-compatible-api');
		assert.equal(record.model, 'lmstudio:test');
		assert.equal(record.capabilities.jsonMode, true);
		assert.equal(record.probes.every((probe) => probe.passed), true);
	});

	it('uses the same measured contract for Claude, Gemini, and Grok providers', async () => {
		const fixtures = [
			['cloud-anthropic', 'anthropicProvider', 'live-anthropic-messages-api'],
			['cloud-gemini', 'geminiProvider', 'live-gemini-generate-content-api'],
			['cloud-xai', 'xaiProvider', 'live-xai-chat-completions-api']
		];
		for (const [providerId, optionName, source] of fixtures) {
			const record = await runProviderCapabilityProbes(providerId, new Date('2026-07-10T12:00:00.000Z'), {
				[optionName]: { completeStructured: async () => ({ value: { ready: true }, usage: { totalTokens: 7 } }) }
			});
			assert.equal(record.source, source);
			assert.equal(record.capabilities.jsonMode, true);
			assert.equal(record.probes.every((probe) => probe.passed), true);
		}
	});

	it('rejects unknown providers', async () => {
		await assert.rejects(() => runProviderCapabilityProbes('unknown'), /Unknown provider/);
	});
});
