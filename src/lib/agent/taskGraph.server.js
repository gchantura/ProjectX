const TERMINAL_PASSING_STATUSES = new Set(['verified']);
const TERMINAL_BLOCKING_STATUSES = new Set(['failed', 'stopped']);
const ACTIVE_STATUSES = new Set(['running', 'retrying']);

export function deriveTaskGraph(run) {
	if (!run?.id || !Array.isArray(run.steps)) {
		throw Object.assign(new Error('Task graph requires a persisted run.'), { status: 400 });
	}

	const nodes = run.steps.map((step, index) => buildNode(step, index, run.steps));
	const edges = nodes
		.filter((node) => node.dependencies.length > 0)
		.flatMap((node) =>
			node.dependencies.map((source) => ({
				id: `${source}->${node.id}`,
				source,
				target: node.id,
				status: edgeStatus(nodes.find((candidate) => candidate.id === source), node)
			}))
		);
	const runnable = nodes.filter((node) => node.state === 'runnable').map((node) => node.id);
	const blocked = nodes.filter((node) => node.state === 'blocked').map((node) => node.id);
	const verified = nodes.filter((node) => node.state === 'satisfied').map((node) => node.id);
	const criticalPath = nodes.map((node) => node.id);
	const activeNode = nodes.find((node) => ACTIVE_STATUSES.has(node.status))?.id ?? runnable[0] ?? null;

	return {
		runId: run.id,
		status: run.status,
		summary: {
			totalNodes: nodes.length,
			verifiedNodes: verified.length,
			blockedNodes: blocked.length,
			runnableNodes: runnable.length,
			remainingNodes: nodes.length - verified.length
		},
		nodes,
		edges,
		criticalPath,
		activeNode,
		runnable,
		blocked
	};
}

function buildNode(step, index, steps) {
	const dependencies = index === 0 ? [] : [steps[index - 1].id];
	const dependencyStatuses = dependencies.map((id) => steps.find((candidate) => candidate.id === id)?.status);
	const dependenciesSatisfied = dependencyStatuses.every((status) => TERMINAL_PASSING_STATUSES.has(status));
	const dependencyBlocked = dependencyStatuses.some((status) => TERMINAL_BLOCKING_STATUSES.has(status));

	return {
		id: step.id,
		label: step.title,
		role: step.role,
		tool: step.toolCall?.name ?? step.tool,
		status: step.status,
		risk: step.risk,
		state: nodeState(step.status, dependenciesSatisfied, dependencyBlocked),
		dependencies,
		verifierReason: step.verification?.reason ?? '',
		evidenceCount: step.verification?.evidence?.length ?? 0
	};
}

function nodeState(status, dependenciesSatisfied, dependencyBlocked) {
	if (TERMINAL_PASSING_STATUSES.has(status)) return 'satisfied';
	if (ACTIVE_STATUSES.has(status)) return 'active';
	if (status === 'failed') return 'failed';
	if (dependencyBlocked || !dependenciesSatisfied) return 'blocked';
	if (status === 'planned' || status === 'stopped') return 'runnable';
	return 'blocked';
}

function edgeStatus(source, target) {
	if (!source) return 'blocked';
	if (source.state === 'satisfied' && target.state !== 'blocked') return 'open';
	if (source.state === 'satisfied') return 'ready';
	if (source.state === 'failed') return 'failed';
	return 'blocked';
}
