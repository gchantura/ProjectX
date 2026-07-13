import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExecutionContext, validateExecutionContext } from './executionContext.server.js';

const env = { NODE_ENV: 'test', KCEV_EXECUTION_CONTEXT_SECRET: 'a'.repeat(32) };
const config = {
	projectId: 'project-context',
	workspaceRoot: 'C:/workspace/project',
	autonomyMode: 'execute',
	allowedPaths: ['src/', 'docs/'],
	networkAllowlist: [],
	requireApprovalForSourceWrites: true,
	provider: 'local-ollama',
	model: 'ornith:9b',
	stepCeiling: 6,
	maxTokensPerRun: 100000,
	costCeilingUsd: 0
};
const readiness = { repository: { root: 'C:/workspace/project', commit: 'abcdef123456', branch: 'main' } };

test('creates a signed immutable execution context with actor, correlation, commit, and policy evidence', () => {
	const context = createExecutionContext({ config, readiness, actor: 'operator-42', correlationId: 'request-12345678', now: new Date('2026-07-13T00:00:00.000Z'), env });
	assert.equal(context.projectId, 'project-context');
	assert.equal(context.commit, 'abcdef123456');
	assert.equal(context.actor, 'operator-42');
	assert.equal(context.correlationId, 'request-12345678');
	assert.match(context.policySha256, /^[a-f0-9]{64}$/);
	assert.match(context.signature, /^[a-f0-9]{64}$/);
	assert.equal(Object.isFrozen(context), true);
	assert.equal(validateExecutionContext(context, { config, readiness, env }).valid, true);
});

test('rejects context tampering, policy drift, repository drift, and project substitution', () => {
	const context = createExecutionContext({ config, readiness, env });
	assert.match(validateExecutionContext({ ...context, actor: 'attacker' }, { config, readiness, env }).reason, /signature/i);
	assert.match(validateExecutionContext(context, { config: { ...config, allowedPaths: ['src/'] }, readiness, env }).reason, /policy changed/i);
	assert.match(validateExecutionContext(context, { config, readiness: { repository: { ...readiness.repository, commit: 'different' } }, env }).reason, /commit changed/i);
	assert.match(validateExecutionContext(context, { config: { ...config, projectId: 'project-other' }, readiness, env }).reason, /project does not match/i);
});

test('requires an independent signing secret in production', () => {
	assert.throws(() => createExecutionContext({ config, readiness, env: { NODE_ENV: 'production', KCEV_OPERATOR_TOKEN: 'o'.repeat(32) } }), (error) => error.code === 'EXECUTION_CONTEXT_SECRET_MISSING');
});
