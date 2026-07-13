import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { collectDiagnostics } from './diagnostics.server.js';
import { clearStoredRunsForTest, persistRun, persistRunEvents } from './runStore.server.js';

let storeDir;
let originalEnv;

beforeEach(async () => {
	storeDir = await mkdtemp(join(tmpdir(), 'kcevagent-diagnostics-'));
	originalEnv = {
		KCEV_AGENT_DATA_DIR: process.env.KCEV_AGENT_DATA_DIR,
		KCEV_STORAGE_BACKEND: process.env.KCEV_STORAGE_BACKEND,
		KCEV_MEMORY_BACKEND: process.env.KCEV_MEMORY_BACKEND,
		NODE_ENV: process.env.NODE_ENV,
		KCEV_AUTH_REQUIRED: process.env.KCEV_AUTH_REQUIRED,
		KCEV_OPERATOR_TOKEN: process.env.KCEV_OPERATOR_TOKEN,
		KCEV_OPERATORS_JSON: process.env.KCEV_OPERATORS_JSON,
		KCEV_SESSION_SECRET: process.env.KCEV_SESSION_SECRET,
		KCEV_OIDC_ISSUER: process.env.KCEV_OIDC_ISSUER,
		KCEV_OIDC_CLIENT_ID: process.env.KCEV_OIDC_CLIENT_ID,
		KCEV_OIDC_CLIENT_SECRET: process.env.KCEV_OIDC_CLIENT_SECRET,
		KCEV_EXECUTION_CONTEXT_SECRET: process.env.KCEV_EXECUTION_CONTEXT_SECRET,
		OLLAMA_MODELS: process.env.OLLAMA_MODELS
	};
	process.env.KCEV_AGENT_DATA_DIR = storeDir;
	delete process.env.KCEV_STORAGE_BACKEND;
	delete process.env.KCEV_MEMORY_BACKEND;
	await clearStoredRunsForTest();
	process.env.OLLAMA_MODELS = join(storeDir, 'ollama-models');
});

afterEach(async () => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(storeDir, { force: true, recursive: true });
});

describe('production diagnostics', () => {
	it('reports storage, providers, local models, security, and event log health without secrets', async () => {
		const run = fixtureRun();
		await persistRun(run);
		await persistRunEvents(run.id, [{ position: 0, type: 'run_completed', payload: { type: 'run_completed', runId: run.id }, createdAt: '2026-07-11T10:00:00.000Z' }]);
		const diagnostics = await collectDiagnostics({ now: new Date('2026-07-11T12:00:00.000Z'), ollamaProvider: { listModels: async () => [{ name: 'local:test', details: { family: 'qwen', parameter_size: '9B', quantization_level: 'Q4' } }] } });
		assert.equal(diagnostics.status, 'ready');
		assert.equal(diagnostics.storage.status, 'passed');
		assert.equal(diagnostics.storage.details.durableRunLeases, true);
		assert.equal(diagnostics.storage.details.activeRunLeases, 0);
		assert.equal(diagnostics.storage.details.durableRunApprovals, true);
		assert.equal(diagnostics.storage.details.pendingRunApprovals, 0);
		assert.equal(diagnostics.events.details.eventCount, 1);
		assert.equal(diagnostics.localModels.details.models[0].name, 'local:test');
		assert.equal(diagnostics.localModels.details.runtimeReachable, true);
		assert.equal(diagnostics.secretEncryption.details.retirementReady, true);
		assert.doesNotMatch(JSON.stringify(diagnostics), /client-secret|authorization|bearer/i);
	});

	it('reports installed local model manifests separately from runtime reachability', async () => {
		const manifest = join(process.env.OLLAMA_MODELS, 'manifests', 'registry.ollama.ai', 'library', 'qwen2.5-coder', '14b');
		await mkdir(join(manifest, '..'), { recursive: true });
		await writeFile(manifest, JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', size: 8988110784 }] }), 'utf8');

		const diagnostics = await collectDiagnostics({ ollamaProvider: { listModels: async () => { throw new Error('offline'); } } });

		assert.equal(diagnostics.localModels.status, 'warning');
		assert.equal(diagnostics.localModels.details.runtimeReachable, false);
		assert.equal(diagnostics.localModels.details.installedCount, 1);
		assert.deepEqual(diagnostics.localModels.details.installedModels[0], {
			name: 'qwen2.5-coder:14b',
			runtime: 'ollama',
			source: 'disk-manifest',
			sizeBytes: 8988110784
		});
	});

	it('fails production security when auth is disabled', async () => {
		process.env.NODE_ENV = 'production';
		process.env.KCEV_AUTH_REQUIRED = 'false';
		delete process.env.KCEV_OPERATOR_TOKEN;
		const diagnostics = await collectDiagnostics({ ollamaProvider: { listModels: async () => [] } });
		assert.equal(diagnostics.status, 'degraded');
		assert.equal(diagnostics.security.status, 'failed');
	});

	it('fails production security when execution-context signing is not independently configured', async () => {
		process.env.NODE_ENV = 'production';
		process.env.KCEV_AUTH_REQUIRED = 'true';
		process.env.KCEV_OPERATOR_TOKEN = 'operator-token-that-is-long-enough-1234';
		delete process.env.KCEV_EXECUTION_CONTEXT_SECRET;
		const diagnostics = await collectDiagnostics({ ollamaProvider: { listModels: async () => [] } });
		assert.equal(diagnostics.security.status, 'failed');
		assert.equal(diagnostics.security.details.tokenConfigured, true);
		assert.equal(diagnostics.security.details.contextSigningConfigured, false);
	});

	it('passes production identity only with independent session and execution signing', async () => {
		process.env.NODE_ENV = 'production';
		process.env.KCEV_AUTH_REQUIRED = 'true';
		process.env.KCEV_OPERATOR_TOKEN = 'operator-token-that-is-long-enough-1234';
		process.env.KCEV_SESSION_SECRET = 'session-secret-that-is-independent-1234';
		process.env.KCEV_EXECUTION_CONTEXT_SECRET = 'context-secret-that-is-independent-1234';
		const diagnostics = await collectDiagnostics({ ollamaProvider: { listModels: async () => [] } });
		assert.equal(diagnostics.security.status, 'passed');
		assert.equal(diagnostics.security.details.sessionSigningConfigured, true);
	});

	it('probes configured OIDC discovery as a readiness dependency', async () => {
		process.env.KCEV_OIDC_ISSUER = 'https://idp.example.com';
		process.env.KCEV_OIDC_CLIENT_ID = 'kcev-client';
		process.env.KCEV_OIDC_CLIENT_SECRET = 'client-secret';
		const metadata = { issuer: 'https://idp.example.com', authorization_endpoint: 'https://idp.example.com/authorize', token_endpoint: 'https://idp.example.com/token', jwks_uri: 'https://idp.example.com/jwks', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] };
		const diagnostics = await collectDiagnostics({ ollamaProvider: { listModels: async () => [] }, oidcFetch: async () => Response.json(metadata) });
		assert.equal(diagnostics.federation.status, 'passed');
		assert.equal(diagnostics.federation.details.pkceS256, true);
	});
});

function fixtureRun() {
	return {
		id: 'run-diagnostics-test',
		task: 'Diagnose production readiness',
		status: 'verified',
		startedAt: '2026-07-11T10:00:00.000Z',
		endedAt: '2026-07-11T10:01:00.000Z',
		config: { provider: 'deterministic-local', model: 'kcev-sim-1', domain: 'coding', stepCeiling: 1, costCeilingUsd: 0 },
		summary: { totalSteps: 1, verifiedSteps: 1, failedSteps: 0, remainingSteps: 0, estimatedCostUsd: 0 },
		steps: [{ id: 'inspect', role: 'executor', title: 'Inspect', description: 'Inspect', status: 'verified', risk: 'low', tool: 'inspect_context', toolCall: { name: 'inspect_context', args: { path: 'PROJECT_MAP.md' } }, rawOutput: 'ok', verification: { verified: true, reason: 'ok', evidence: ['file:PROJECT_MAP.md'] } }],
		guardrails: [],
		nextActions: []
	};
}
