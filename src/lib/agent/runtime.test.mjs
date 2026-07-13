import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentRun, validateToolCall } from './runtime.js';

test('creates a verified deterministic run with evidence for each step', () => {
	const run = createAgentRun('Build an operator UI for the agent system');

	assert.equal(run.status, 'verified');
	assert.ok(run.steps.length >= 4);
	assert.equal(run.summary.failedSteps, 0);
	assert.ok(run.steps.every((step) => step.verification.evidence.length > 0));
	assert.equal(run.steps[1].toolCall.name, 'write_artifact');
	assert.match(run.steps[1].toolCall.args.path, /^\.kcevagent\/artifacts\//);
});

test('rejects dangerous shell commands before execution', () => {
	const result = validateToolCall({
		name: 'run_validation',
		args: { command: 'git reset --hard HEAD' }
	});

	assert.equal(result.allowed, false);
	assert.match(result.reason, /sandbox policy/);
});

test('rejects source writes without approval before execution', () => {
	const result = validateToolCall({
		name: 'write_source',
		args: { path: 'docs/example.md', content: '# example' }
	});

	assert.equal(result.allowed, false);
	assert.match(result.reason, /approval/);
});

test('enforces step ceiling and reports remaining work', () => {
	const run = createAgentRun('Build UI, provider adapter, Supabase database, logs, and model API', {
		stepCeiling: 2
	});

	assert.equal(run.status, 'stopped');
	assert.equal(run.steps.length, 2);
	assert.ok(run.summary.remainingSteps > 0);
	assert.equal(run.guardrails[0].status, 'tripped');
});

test('compiles deterministic runs to the selected autonomy capability set', () => {
	const analyzeRun = createAgentRun('Build UI and run validation', { autonomyMode: 'analyze', stepCeiling: 6 });
	const proposeRun = createAgentRun('Build UI and run validation', { autonomyMode: 'propose', stepCeiling: 6 });
	assert.ok(analyzeRun.steps.length > 0);
	assert.ok(analyzeRun.steps.every((step) => ['list_workspace', 'search_workspace', 'inspect_context', 'inspect_diff', 'analyze_impact'].includes(step.tool)));
	assert.ok(proposeRun.steps.some((step) => step.tool === 'write_artifact'));
	assert.ok(proposeRun.steps.every((step) => step.tool !== 'edit_source' && step.tool !== 'run_validation'));
});
