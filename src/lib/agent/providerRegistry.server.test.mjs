import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
	getProviderReadiness,
	listProviderReadiness,
	runProviderReadinessProbe
} from './providerRegistry.server.js';

let storeDir;
let originalEnv;

beforeEach(async () => {
	storeDir = await mkdtemp(join(tmpdir(), 'kcevagent-provider-registry-'));
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

test('lists deterministic provider as blocked before probes are measured', async () => {
	const provider = await getProviderReadiness('deterministic-local');

	assert.equal(provider.ready, false);
	assert.equal(provider.checkedAt, null);
	assert.equal(provider.probeSource, 'not-run');
	assert.ok(provider.probes.every((probe) => probe.status === 'blocked'));
});

test('lists deterministic provider as ready after measured capability probes', async () => {
	await runProviderReadinessProbe('deterministic-local');
	const provider = await getProviderReadiness('deterministic-local');

	assert.equal(provider.ready, true);
	assert.equal(provider.capabilities.nativeToolCalling, true);
	assert.equal(provider.capabilities.streaming, true);
	assert.equal(provider.reliabilityScore, 100);
	assert.ok(provider.checkedAt);
	assert.ok(provider.probes.every((probe) => probe.status === 'passed'));
});

test('blocks cloud provider until live probes and credentials are configured', async () => {
	const provider = await runProviderReadinessProbe('cloud-openai');

	assert.equal(provider.ready, false);
	assert.equal(provider.status, 'blocked');
	assert.equal(provider.capabilities.nativeToolCalling, false);
	assert.ok(provider.probes.some((probe) => probe.id === 'api-key' && !probe.passed));
});

test('enables cloud provider after measured structured execution', async () => {
	const provider = await runProviderReadinessProbe('cloud-openai', {
		openAIProvider: { completeStructured: async () => ({ value: { ready: true }, usage: { totalTokens: 4 } }) }
	});
	assert.equal(provider.ready, true);
	assert.equal(provider.status, 'ready');
	assert.equal(provider.reliabilityScore, 100);
	assert.equal(provider.capabilities.jsonMode, true);
});

test('binds readiness evidence to the exact provider and model pair', async () => {
	await runProviderReadinessProbe('cloud-openai', {
		model: 'gpt-probed',
		openAIProvider: { completeStructured: async () => ({ value: { ready: true }, usage: { totalTokens: 4 } }) }
	});
	const probed = await getProviderReadiness('cloud-openai', 'gpt-probed');
	const unprobed = await getProviderReadiness('cloud-openai', 'gpt-unprobed');
	assert.equal(probed.ready, true);
	assert.equal(probed.probedModel, 'gpt-probed');
	assert.equal(unprobed.ready, false);
	assert.equal(unprobed.checkedAt, null);
});

test('returns all registered provider readiness records', async () => {
	const providers = await listProviderReadiness();

	assert.deepEqual(
		providers.map((provider) => provider.id),
		['deterministic-local', 'cloud-openai', 'cloud-anthropic', 'cloud-gemini', 'cloud-xai', 'local-ollama', 'local-openai-compatible']
	);
	assert.ok(providers.every((provider) => Array.isArray(provider.probes)));
});
