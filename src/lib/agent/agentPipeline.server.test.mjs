import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, it } from 'node:test';
import { createProviderPlannedRun, createProviderStepMaterializer } from './agentPipeline.server.js';

const artifact = '.kcevagent/artifacts/provider-pipeline-test.md';
const editTarget = 'docs/provider-edit-test.md';
afterEach(async () => { await rm(artifact, { force: true }); await rm(editTarget, { force: true }); });

describe('provider agent pipeline', () => {
	it('limits planner schemas to the selected autonomy capability set', async () => {
		let request;
		const provider = { async completeStructured(input) { request = input; return { value: { steps: [{ id: 'read', title: 'Read map', description: 'Read map.', tool: 'inspect_context', arguments_json: '{"path":"PROJECT_MAP.md"}', depends_on: [], risk: 'low', evidence_required: 'map' }] }, model: 'test', attempts: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; } };
		await createProviderPlannedRun('Investigate the architecture', { model: 'test', stepCeiling: 3, workspaceScope: 'repo', autonomyMode: 'analyze' }, { provider });
		assert.deepEqual(request.schema.properties.steps.items.properties.tool.enum, ['list_workspace', 'search_workspace', 'inspect_context', 'inspect_diff', 'analyze_impact']);
		assert.match(request.messages[0].content, /no files or artifacts may be written/i);
	});

	it('compiles explicit read-only file objectives without probabilistic planner output', async () => {
		const provider = fixtureProvider([]);
		const run = await createProviderPlannedRun('Inspect PROJECT_MAP.md and summarize the architecture without editing files.', { model: 'ornith:9b', stepCeiling: 4, workspaceScope: 'src/, PROJECT_MAP.md', allowedPaths: ['src/', 'PROJECT_MAP.md'], planningMode: 'multi-hypothesis' }, { provider });
		assert.equal(run.steps.length, 1);
		assert.equal(run.steps[0].tool, 'inspect_context');
		assert.equal(run.steps[0].toolCall.args.path, 'PROJECT_MAP.md');
		assert.equal(run.providerTrace.planningMode, 'policy-compiled');
	});

	it('plans, executes, and independently verifies a real tool step', async () => {
		const provider = fixtureProvider([
			{ value: { steps: [{ id: 'write-evidence', title: 'Write evidence', description: 'Create a bounded audit artifact.', tool: 'write_artifact', arguments_json: JSON.stringify({ path: artifact, content: '# Provider pipeline evidence' }), depends_on: [], risk: 'medium', evidence_required: 'Artifact write path and byte count.' }] } },
			{ value: { verified: true, reason: 'Artifact path and byte count prove creation.', evidence_checked: [`artifact:${artifact}`] } }
		]);
		const config = { provider: 'cloud-openai', model: 'gpt-5.5', domain: 'coding', stepCeiling: 4, workspaceScope: 'current project', costCeilingUsd: 5 };
		const run = await createProviderPlannedRun('Write audit evidence', config, { provider });
		const materialize = createProviderStepMaterializer({ provider });
		const step = await materialize(run.steps[0], config);
		assert.equal(run.steps.length, 1);
		assert.equal(step.status, 'verified');
		assert.match(step.rawOutput, /Artifact written/);
		assert.equal(step.providerTrace.verifier.usage.totalTokens, 15);
	});

	it('rejects invalid planner dependencies before any tool runs', async () => {
		const provider = fixtureProvider([{ value: { steps: [{ id: 'bad', title: 'Bad', description: 'Invalid dependency.', tool: 'inspect_context', arguments_json: '{"path":"PROJECT_MAP.md"}', depends_on: ['missing'], risk: 'low', evidence_required: 'file' }] } }]);
		await assert.rejects(() => createProviderPlannedRun('test', { model: 'gpt-5.5', stepCeiling: 4, workspaceScope: 'repo' }, { provider }), /invalid dependency/);
	});

	it('canonicalizes unambiguous ordinal dependencies from local model plans', async () => {
		const provider = fixtureProvider([{ value: { steps: [
			{ id: 'inspect-readme', title: 'Inspect README', description: 'Read the file.', tool: 'inspect_context', arguments_json: '{"path":"README.md"}', depends_on: [], risk: 'low', evidence_required: 'heading' },
			{ id: 'report-heading', title: 'Report heading', description: 'Write the result.', tool: 'write_artifact', arguments_json: '{"path":".kcevagent/artifacts/heading.md","content":"heading"}', depends_on: ['step-1'], risk: 'medium', evidence_required: 'artifact' }
		] } }]);
		const run = await createProviderPlannedRun('Inspect README', { model: 'ornith:9b', stepCeiling: 4, workspaceScope: 'repo' }, { provider });
		assert.deepEqual(run.steps[1].dependsOn, ['inspect-readme']);
	});

	it('rejects unresolved planner templates before a filesystem tool runs', async () => {
		const provider = fixtureProvider([{ value: { steps: [{ id: 'read', title: 'Read', description: 'Read discovered file.', tool: 'inspect_context', arguments_json: '{"path":"{{list_workspace.output.path}}"}', depends_on: [], risk: 'low', evidence_required: 'file' }] } }]);
		await assert.rejects(() => createProviderPlannedRun('read', { model: 'ornith:9b', stepCeiling: 4, workspaceScope: 'repo' }, { provider }), /unresolved template arguments/);
	});

	it('rejects planner paths outside the admitted project roots before execution', async () => {
		const provider = fixtureProvider([{ value: { steps: [{ id: 'list-root', title: 'List root', description: 'List everything.', tool: 'list_workspace', arguments_json: '{"path":"."}', depends_on: [], risk: 'low', evidence_required: 'files' }] } }]);
		await assert.rejects(() => createProviderPlannedRun('Find logs', { model: 'ornith:9b', stepCeiling: 4, workspaceScope: 'src/, docs/', allowedPaths: ['src/', 'docs/'] }, { provider }), /outside project policy/);
	});

	it('adjudicates competing plans and retains the losing hypothesis', async () => {
		const planA = { steps: [{ id: 'read-a', title: 'Read map', description: 'Read map.', tool: 'inspect_context', arguments_json: '{"path":"PROJECT_MAP.md"}', depends_on: [], risk: 'low', evidence_required: 'map' }] };
		const planB = { steps: [{ id: 'search-b', title: 'Search runtime', description: 'Search runtime.', tool: 'search_workspace', arguments_json: '{"query":"orchestrator","path":"src"}', depends_on: [], risk: 'low', evidence_required: 'matches' }] };
		const provider = fixtureProvider([{ value: planA }, { value: planB }, { value: { selected_candidate: 'candidate_b', rationale: 'Search gives more direct evidence.', strengths: ['targeted'], risks: ['may miss aliases'] } }]);
		const run = await createProviderPlannedRun('Find orchestrator', { model: 'gpt-5.5', stepCeiling: 4, workspaceScope: 'repo', planningMode: 'multi-hypothesis' }, { provider });
		assert.equal(run.steps[0].id, 'search-b');
		assert.equal(run.providerTrace.selected, 'candidate_b');
		assert.equal(run.providerTrace.plannerCandidates.candidate_a.steps[0].id, 'read-a');
		assert.equal(run.summary.totalTokens, 45);
	});

	it('uses the valid hypothesis when the competing local-model plan is malformed', async () => {
		const valid = { steps: [{ id: 'read', title: 'Read map', description: 'Read map.', tool: 'inspect_context', arguments_json: '{"path":"PROJECT_MAP.md"}', depends_on: [], risk: 'low', evidence_required: 'map' }] };
		const invalid = { steps: [{ id: '', title: 'Search', description: 'Search.', tool: 'search_workspace', arguments_json: '{"query":"map"}', depends_on: ['list_workspace'], risk: 'low', evidence_required: 'matches' }] };
		const provider = fixtureProvider([{ value: valid }, { value: invalid }]);
		const run = await createProviderPlannedRun('Find map', { model: 'ornith:9b', stepCeiling: 4, workspaceScope: 'repo', planningMode: 'multi-hypothesis' }, { provider });
		assert.equal(run.steps[0].id, 'read');
		assert.equal(run.providerTrace.selected, 'candidate_a');
		assert.match(run.providerTrace.plannerCandidates.candidate_b.rejected, /invalid dependency/);
		assert.equal(run.providerTrace.adjudicator.skipped, true);
	});

	it('makes one bounded repair attempt when both hypotheses are malformed', async () => {
		const invalid = { steps: [{ id: 'bad', title: 'Bad', description: 'Bad.', tool: 'inspect_context', arguments_json: '{"path":"{{path}}"}', depends_on: [], risk: 'low', evidence_required: 'file' }] };
		const repaired = { steps: [{ id: 'read', title: 'Read', description: 'Read.', tool: 'inspect_context', arguments_json: '{"path":"README.md"}', depends_on: [], risk: 'low', evidence_required: 'heading' }] };
		const provider = fixtureProvider([{ value: invalid }, { value: invalid }, { value: repaired }]);
		const run = await createProviderPlannedRun('Read README', { model: 'ornith:9b', stepCeiling: 4, workspaceScope: 'repo', planningMode: 'multi-hypothesis' }, { provider });
		assert.equal(run.providerTrace.selected, 'repair');
		assert.equal(run.steps[0].toolCall.args.path, 'README.md');
		assert.equal(run.summary.totalTokens, 45);
	});

	it('fails verification when positive evidence is absent', async () => {
		const provider = fixtureProvider([{ value: { verified: true, reason: 'Looks fine.', evidence_checked: [] } }]);
		const materialize = createProviderStepMaterializer({ provider });
		const step = await materialize({ id: 'read', description: 'Read map', evidenceRequired: 'file contents', toolCall: { name: 'inspect_context', args: { path: 'PROJECT_MAP.md' } }, verification: { evidence: [] } }, { model: 'gpt-5.5' });
		assert.equal(step.status, 'failed');
		assert.ok(step.verification.evidence.includes('verifier:rejected'));
	});

	it('adapts an edit step from completed evidence and records executor trace', async () => {
		await writeFile(editTarget, '# Unique capability\nBefore\n', 'utf8');
		const provider = fixtureProvider([
			{ value: { tool: 'edit_source', arguments_json: JSON.stringify({ path: editTarget, edits: [{ oldText: 'Before', newText: 'After' }] }), summary: 'Apply exact replacement.' } },
			{ value: { verified: true, reason: 'Atomic edit evidence proves the source changed.', evidence_checked: [`source-write:${editTarget}`] } }
		]);
		const materialize = createProviderStepMaterializer({ provider });
		const step = await materialize({ id: 'edit', tool: 'edit_source', title: 'Edit source', description: 'Change Before to After.', evidenceRequired: 'Atomic source hash transition.', toolCall: { name: 'edit_source', args: { path: editTarget, edits: [{ oldText: 'placeholder', newText: 'placeholder' }] } }, verification: { evidence: [] } }, { model: 'gpt-5.5' }, { completedSteps: [{ id: 'inspect', tool: 'inspect_context', status: 'verified', rawOutput: '# Unique capability\nBefore\n', verification: { evidence: [`file:${editTarget}`] } }] });
		assert.equal(step.status, 'verified');
		assert.equal(await readFile(editTarget, 'utf8'), '# Unique capability\nAfter\n');
		assert.equal(step.providerTrace.executor.model, 'gpt-5.5');
	});
});

function fixtureProvider(fixtures) {
	let index = 0;
	return { async completeStructured() { const fixture = fixtures[index++]; return { ...fixture, providerResponseId: `resp_${index}`, requestId: `req_${index}`, model: 'gpt-5.5', attempts: 1, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }; } };
}
