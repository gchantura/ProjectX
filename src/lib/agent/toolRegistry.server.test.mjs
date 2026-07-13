import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createAgentRun } from './runtime.js';
import {
	executeAgentTool,
	materializeRunTools,
	resolveArtifactPath,
	resolveSourceWritePath,
	resolveWorkspacePath
} from './toolRegistry.server.js';
import { createExecutionContext } from './executionContext.server.js';

test('reads workspace-scoped context files', async () => {
	const result = await executeAgentTool({
		name: 'inspect_context',
		args: { path: 'PROJECT_MAP.md' }
	});

	assert.equal(result.ok, true);
	assert.match(result.output, /Project Map/);
	assert.deepEqual(result.evidence, ['file:PROJECT_MAP.md']);
});

test('discovers and searches workspace files with bounded evidence', async () => {
	const listed = await executeAgentTool({ name: 'list_workspace', args: { path: 'src/lib/agent', limit: 200 } });
	const searched = await executeAgentTool({ name: 'search_workspace', args: { path: 'src/lib/agent', query: 'createAgentRun' } });
	assert.equal(listed.ok, true);
	assert.match(listed.output, /runtime\.js/);
	const fileCount = Number(listed.evidence.find((item) => item.startsWith('files:'))?.slice(6));
	assert.ok(fileCount > 20 && fileCount <= 200);
	assert.equal(searched.ok, true);
	assert.match(searched.output, /createAgentRun/);
});

test('inspects Git diffs without allowing arbitrary Git commands', async () => {
	const result = await executeAgentTool({ name: 'inspect_diff', args: { path: 'src/lib/agent/runtime.js' } });
	assert.equal(result.ok, true);
	assert.ok(result.evidence.includes('git-diff:working-tree'));
});

test('rejects paths outside the workspace', () => {
	assert.throws(() => resolveWorkspacePath('../outside.txt'), /outside workspace/);
});

test('enforces configured path allowlists for reads and source writes', async () => {
	assert.throws(() => resolveWorkspacePath('docs/PRODUCTION.md', { allowedPaths: ['src/'] }), /configured allowlist/);
	assert.doesNotThrow(() => resolveWorkspacePath('src/lib/agent/runtime.js', { allowedPaths: ['src/'] }));
	const read = await executeAgentTool({ name: 'inspect_context', args: { path: 'PROJECT_MAP.md' } }, { allowedPaths: ['src/'] });
	assert.equal(read.ok, false);
	assert.match(read.output, /configured allowlist/);
	const write = await executeAgentTool({ name: 'write_source', args: { path: 'docs/blocked.md', content: '# blocked', approval: { approved: true, id: 'approval-allowlist', path: 'docs/blocked.md' } } }, { allowedPaths: ['src/'] });
	assert.equal(write.ok, false);
	assert.match(write.output, /configured allowlist/);
});

test('writes artifacts only inside the artifact sandbox', async () => {
	const artifactPath = '.kcevagent/artifacts/test-artifact.md';
	await rm(artifactPath, { force: true });

	const result = await executeAgentTool({
		name: 'write_artifact',
		args: {
			path: artifactPath,
			content: '# Test artifact\n\nScoped output.'
		}
	});

	assert.equal(result.ok, true);
	assert.deepEqual(result.evidence, [`artifact:${artifactPath}`]);
	assert.match(await readFile(artifactPath, 'utf8'), /Scoped output/);

	await rm(artifactPath, { force: true });
});

test('rejects artifact writes outside the artifact sandbox', () => {
	assert.throws(() => resolveArtifactPath('src/lib/not-allowed.md'), /Writable artifacts/);
});

test('rejects source writes without approval', async () => {
	const result = await executeAgentTool({
		name: 'write_source',
		args: { path: 'docs/source-write-test.md', content: '# nope' }
	});

	assert.equal(result.ok, false);
	assert.match(result.output, /approval/i);
});

test('rejects source writes outside allowed roots', () => {
	assert.throws(() => resolveSourceWritePath('package.json'), /Source writes/);
});

test('writes approved source files inside allowed roots', async () => {
	const path = 'docs/source-write-test.md';
	await rm(path, { force: true });

	const result = await executeAgentTool({
		name: 'write_source',
		args: {
			path,
			content: '# Source write test\n\nApproved content.',
			approval: { approved: true, id: 'approval-test-1', path }
		}
	});

	assert.equal(result.ok, true);
	assert.deepEqual(result.evidence, [`source-write:${path}`, 'approval:approval-test-1']);
	assert.match(await readFile(path, 'utf8'), /Approved content/);

	await rm(path, { force: true });
});

test('atomically edits source with exact-match and optimistic concurrency safeguards', async () => {
	const target = 'docs/edit-source-test.md';
	await writeFile(target, '# Before\n', 'utf8');
	try {
		const result = await executeAgentTool({ name: 'edit_source', args: { path: target, edits: [{ oldText: '# Before', newText: '# After' }] } });
		assert.equal(result.ok, true, result.output);
		assert.equal(await readFile(target, 'utf8'), '# After\n');
		assert.match(result.output, /Atomically edited/);
		const stale = await executeAgentTool({ name: 'edit_source', args: { path: target, expectedSha256: '0'.repeat(64), edits: [{ oldText: '# After', newText: '# Never' }] } });
		assert.equal(stale.ok, false);
		assert.match(stale.output, /changed since inspection/);
		const checkpoint = result.evidence.find((item) => item.startsWith('checkpoint:')).slice('checkpoint:'.length);
		const rollback = await executeAgentTool({ name: 'rollback_checkpoint', args: { checkpointId: checkpoint } });
		assert.equal(rollback.ok, true, rollback.output);
		assert.equal(await readFile(target, 'utf8'), '# Before\n');
		assert.ok(rollback.evidence.includes(`source-restored:${target}`));
	} finally { await rm(target, { force: true }); }
});

test('rejects approved source writes when the approval path differs', async () => {
	const result = await executeAgentTool({
		name: 'write_source',
		args: {
			path: 'docs/source-write-test.md',
			content: '# mismatch',
			approval: { approved: true, id: 'approval-test-2', path: 'docs/other.md' }
		}
	});

	assert.equal(result.ok, false);
	assert.match(result.output, /path does not match/);
});

test('rejects non-allowlisted validation commands', async () => {
	const result = await executeAgentTool({
		name: 'run_validation',
		args: { command: 'npm install' }
	});

	assert.equal(result.ok, false);
	assert.match(result.output, /not allowlisted/);
});

test('enforces autonomy policy at the tool execution boundary', async () => {
	const analyzeWrite = await executeAgentTool({ name: 'write_artifact', args: { path: '.kcevagent/artifacts/blocked.md', content: 'blocked' } }, { autonomyMode: 'analyze' });
	const proposeEdit = await executeAgentTool({ name: 'edit_source', args: { path: 'docs/blocked.md', edits: [{ oldText: 'a', newText: 'b' }] } }, { autonomyMode: 'propose' });
	const analyzeRead = await executeAgentTool({ name: 'inspect_context', args: { path: 'PROJECT_MAP.md' } }, { autonomyMode: 'analyze' });
	assert.equal(analyzeWrite.ok, false);
	assert.match(analyzeWrite.output, /not permitted in analyze/);
	assert.equal(proposeEdit.ok, false);
	assert.match(proposeEdit.output, /not permitted in propose/);
	assert.equal(analyzeRead.ok, true);
});

test('rejects tool execution when admitted policy has been altered', async () => {
	const admittedConfig = {
		projectId: 'project-tool-context', workspaceRoot: process.cwd(), autonomyMode: 'execute',
		allowedPaths: ['src/', 'PROJECT_MAP.md'], networkAllowlist: [], requireApprovalForSourceWrites: true,
		provider: 'deterministic-local', model: 'kcev-sim-1', stepCeiling: 6, maxTokensPerRun: 100000, costCeilingUsd: 0
	};
	const executionContext = createExecutionContext({ config: admittedConfig, readiness: { repository: { root: process.cwd(), commit: 'test-commit', branch: 'test' } } });
	const result = await executeAgentTool({ name: 'inspect_context', args: { path: 'PROJECT_MAP.md' } }, {
		...admittedConfig,
		allowedPaths: ['docs/'],
		executionContext
	});
	assert.equal(result.ok, false);
	assert.deepEqual(result.evidence, ['execution-context:rejected']);
	assert.match(result.output, /policy changed/i);
});

test('materializes run steps with server tool evidence', async () => {
	const artifactPaths = ['.kcevagent/artifacts/test-materialize-exec-1.md', '.kcevagent/artifacts/test-materialize-exec-ui.md'];
	const run = createAgentRun('Build UI and run validation', { stepCeiling: 4 });
	run.steps = run.steps.map((step) => step.tool === 'write_artifact' ? { ...step, toolCall: { ...step.toolCall, args: { ...step.toolCall.args, path: `.kcevagent/artifacts/test-materialize-${step.id}.md` } } } : step);
	try {
		const materialized = await materializeRunTools(run);
		assert.equal(materialized.summary.failedSteps, 0);
		assert.ok(materialized.steps.every((step) => step.rawOutput.length > 0));
		assert.ok(materialized.steps.every((step) => step.verification.evidence.length > 3));
	} finally {
		await Promise.all(artifactPaths.map((artifactPath) => rm(artifactPath, { force: true })));
	}
});
