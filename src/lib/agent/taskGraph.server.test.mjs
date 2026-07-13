import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAgentRun } from './runtime.js';
import { deriveTaskGraph } from './taskGraph.server.js';

describe('task graph', () => {
	it('derives sequential dependencies from a persisted run shape', () => {
		const run = createAgentRun('Build UI streaming dashboard', { stepCeiling: 3 });
		const graph = deriveTaskGraph(run);

		assert.equal(graph.runId, run.id);
		assert.equal(graph.nodes.length, 3);
		assert.deepEqual(graph.nodes[0].dependencies, []);
		assert.deepEqual(graph.nodes[1].dependencies, [graph.nodes[0].id]);
		assert.deepEqual(graph.criticalPath, graph.nodes.map((node) => node.id));
		assert.equal(graph.edges.length, 2);
	});

	it('marks the first unfinished step runnable after verified prefix', () => {
		const run = createAgentRun('Build UI streaming dashboard', { stepCeiling: 3 });
		const stopped = {
			...run,
			status: 'stopped',
			steps: [
				{ ...run.steps[0], status: 'verified' },
				{ ...run.steps[1], status: 'stopped' },
				{ ...run.steps[2], status: 'stopped' }
			]
		};
		const graph = deriveTaskGraph(stopped);

		assert.equal(graph.nodes[0].state, 'satisfied');
		assert.equal(graph.nodes[1].state, 'runnable');
		assert.equal(graph.nodes[2].state, 'blocked');
		assert.deepEqual(graph.runnable, [graph.nodes[1].id]);
		assert.equal(graph.activeNode, graph.nodes[1].id);
	});

	it('surfaces failed nodes and blocks their dependents', () => {
		const run = createAgentRun('Build UI streaming dashboard', { stepCeiling: 4 });
		const failed = {
			...run,
			status: 'needs_attention',
			steps: [
				{ ...run.steps[0], status: 'verified' },
				{ ...run.steps[1], status: 'failed' },
				{ ...run.steps[2], status: 'planned' },
				{ ...run.steps[3], status: 'planned' }
			]
		};
		const graph = deriveTaskGraph(failed);

		assert.equal(graph.nodes[1].state, 'failed');
		assert.equal(graph.nodes[2].state, 'blocked');
		assert.deepEqual(graph.blocked, [graph.nodes[2].id, graph.nodes[3].id]);
		assert.equal(graph.edges.find((edge) => edge.source === graph.nodes[1].id).status, 'failed');
	});

	it('rejects invalid graph input', () => {
		assert.throws(() => deriveTaskGraph({ id: 'run-empty' }), /persisted run/);
	});
});
