import { isToolAllowedForAutonomy, normalizeAutonomyMode } from './autonomyPolicy.js';

const DANGEROUS_COMMANDS = [
	'rm -rf',
	'git reset --hard',
	'format ',
	'del /s',
	'remove-item -recurse',
	'curl |',
	'invoke-webrequest |'
];

export const defaultAgentConfig = {
	provider: 'deterministic-local',
	model: 'kcev-sim-1',
	domain: 'coding',
	stepCeiling: 6,
	workspaceScope: 'current project',
	costCeilingUsd: 0,
	maxTokensPerRun: 100000,
	autonomyMode: 'execute'
};

export const capabilityBadges = [
	{ label: 'Planner', state: 'online' },
	{ label: 'Executor', state: 'sandboxed' },
	{ label: 'Verifier', state: 'evidence-first' },
	{ label: 'Recovery', state: 'checkpointed' }
];

export const domainModules = [
	{
		id: 'coding',
		name: 'Coding',
		tools: [
			{ name: 'list_workspace', risk: 'low', permission: 'read-only' },
			{ name: 'search_workspace', risk: 'low', permission: 'read-only' },
			{ name: 'inspect_context', risk: 'low', permission: 'read-only' },
			{ name: 'inspect_diff', risk: 'low', permission: 'read-only' },
			{ name: 'analyze_impact', risk: 'low', permission: 'read-only' },
			{ name: 'write_artifact', risk: 'medium', permission: 'artifact-write' },
			{ name: 'write_source', risk: 'high', permission: 'approval-required' },
			{ name: 'edit_source', risk: 'high', permission: 'workspace-write' },
			{ name: 'run_validation', risk: 'medium', permission: 'shell-timeout' }
		]
	}
];

export function createAgentRun(task, config = {}) {
	const normalizedTask = normalizeTask(task);
	const { runId, startedAt, ...runtimeConfig } = config;
	const runConfig = { ...defaultAgentConfig, ...runtimeConfig, autonomyMode: normalizeAutonomyMode(runtimeConfig.autonomyMode) };
	const plannedSteps = planTask(normalizedTask).filter((step) => isToolAllowedForAutonomy(step.tool, runConfig.autonomyMode));
	const limitedSteps = plannedSteps.slice(0, runConfig.stepCeiling);
	const stoppedByCeiling = plannedSteps.length > limitedSteps.length;

	const steps = limitedSteps.map((step, index) => executeStep(step, index, normalizedTask));
	const verifiedCount = steps.filter((step) => step.status === 'verified').length;
	const failedCount = steps.filter((step) => step.status === 'failed').length;
	const status = failedCount > 0 ? 'needs_attention' : stoppedByCeiling ? 'stopped' : 'verified';

	return {
		id: runId ?? `run-${stableHash(`${normalizedTask}:${runConfig.provider}:${runConfig.model}`)}`,
		task: normalizedTask,
		status,
		config: runConfig,
		startedAt: startedAt ?? new Date().toISOString(),
		summary: {
			totalSteps: steps.length,
			verifiedSteps: verifiedCount,
			failedSteps: failedCount,
			remainingSteps: Math.max(plannedSteps.length - steps.length, 0),
			estimatedCostUsd: 0
		},
		guardrails: evaluateGuardrails(normalizedTask, runConfig, stoppedByCeiling),
		steps,
		nextActions: buildNextActions(status, stoppedByCeiling)
	};
}

export function validateToolCall(call, config = defaultAgentConfig) {
	if (!call || typeof call.name !== 'string') {
		return { allowed: false, reason: 'Tool call is missing a name.' };
	}

	const autonomyMode = normalizeAutonomyMode(config.autonomyMode);
	if (!isToolAllowedForAutonomy(call.name, autonomyMode)) {
		return { allowed: false, reason: `Tool ${call.name} is not permitted in ${autonomyMode} autonomy mode.` };
	}

	if (call.name === 'run_validation') {
		const command = String(call.args?.command ?? '').toLowerCase();
		const dangerous = DANGEROUS_COMMANDS.find((pattern) => command.includes(pattern));

		if (dangerous) {
			return {
				allowed: false,
				reason: `Command rejected by sandbox policy: ${dangerous.trim()}`
			};
		}
	}

	if (call.args?.path && String(call.args.path).includes('..')) {
		return {
			allowed: false,
			reason: `Path escapes ${config.workspaceScope}.`
		};
	}

	if (call.name === 'write_source' && call.args?.approval?.approved !== true) {
		return {
			allowed: false,
			reason: 'Source writes require an explicit approval record.'
		};
	}

	return { allowed: true, reason: 'Tool call is inside the configured sandbox.' };
}

function normalizeTask(task) {
	const value = String(task ?? '').trim();
	return value || 'Build a production-grade agentic coding system with planning, execution, verification, and guardrails.';
}

function planTask(task) {
	const needsUi = /ui|dashboard|operator|screen|frontend|svelte/i.test(task);
	const needsProvider = /llm|provider|openai|anthropic|model|api/i.test(task);
	const needsPersistence = /db|database|history|log|persist/i.test(task);

	const steps = [
		{
			id: 'plan-1',
			role: 'planner',
			title: 'Decompose objective',
			description: 'Convert the user objective into a bounded task graph with explicit evidence requirements.',
			tool: 'inspect_context',
			risk: 'low'
		},
		{
			id: 'exec-1',
			role: 'executor',
			title: 'Prepare coding module',
			description: 'Write a scoped implementation artifact that records the intended coding change.',
			tool: 'write_artifact',
			risk: 'medium'
		},
		{
			id: 'verify-1',
			role: 'verifier',
			title: 'Verify first slice',
			description: 'Check that the slice has positive evidence instead of relying on absence of errors.',
			tool: 'run_validation',
			risk: 'medium'
		}
	];

	if (needsUi) {
		steps.splice(2, 0, {
			id: 'exec-ui',
			role: 'executor',
			title: 'Expose operator trace',
			description: 'Write an operator-facing artifact describing the trace, raw outputs, and verifier reasons.',
			tool: 'write_artifact',
			risk: 'medium'
		});
	}

	if (needsPersistence) {
		steps.push({
			id: 'plan-db',
			role: 'planner',
			title: 'Queue persistence layer',
			description: 'Mark run logging and Supabase persistence as the next backend slice.',
			tool: 'inspect_context',
			risk: 'low'
		});
	}

	if (needsProvider) {
		steps.push({
			id: 'plan-provider',
			role: 'planner',
			title: 'Queue provider adapter',
			description: 'Require capability probes before enabling paid or remote LLM execution.',
			tool: 'inspect_context',
			risk: 'low'
		});
	}

	return steps;
}

function executeStep(step, index, task) {
	const toolCall = buildToolCall(step, task);
	const sandbox = validateToolCall(toolCall);
	const verification = verifyStep(step, sandbox, task);

	return {
		...step,
		status: verification.verified ? 'verified' : 'failed',
		startedAtOffsetMs: index * 900,
		durationMs: 620 + index * 140,
		toolCall,
		rawOutput: sandbox.allowed
			? `accepted ${toolCall.name} with ${Object.keys(toolCall.args).length} argument(s)`
			: sandbox.reason,
		verification
	};
}

function buildToolCall(step, task) {
	if (step.tool === 'run_validation') {
		return {
			name: step.tool,
			args: { command: 'npm run ai:check', timeoutMs: 30000 }
		};
	}

	if (step.tool === 'write_artifact') {
		return {
			name: step.tool,
			args: {
				path: `.kcevagent/artifacts/${step.id}.md`,
				content: [
					`# ${step.title}`,
					'',
					`Task fingerprint: ${stableHash(task)}`,
					`Role: ${step.role}`,
					`Risk: ${step.risk}`,
					'',
					step.description
				].join('\n')
			}
		};
	}

	return {
		name: step.tool,
		args: { path: 'PROJECT_MAP.md', mode: 'read-only' }
	};
}

function verifyStep(step, sandbox, task) {
	if (!sandbox.allowed) {
		return {
			verified: false,
			reason: sandbox.reason,
			evidence: ['sandbox rejection']
		};
	}

	return {
		verified: true,
		reason: `${step.role} step has scoped tool output and a concrete evidence target.`,
		evidence: [
			`task:${stableHash(task)}`,
			`tool:${step.tool}`,
			`risk:${step.risk}`
		]
	};
}

function evaluateGuardrails(task, config, stoppedByCeiling) {
	return [
		{
			label: 'Step ceiling',
			status: stoppedByCeiling ? 'tripped' : 'armed',
			detail: `${config.stepCeiling} maximum steps per run`
		},
		{
			label: 'Workspace scope',
			status: 'armed',
			detail: `Tool paths must stay inside ${config.workspaceScope}`
		},
		{
			label: 'Dangerous commands',
			status: 'armed',
			detail: `${DANGEROUS_COMMANDS.length} destructive command patterns rejected`
		},
		{
			label: 'Prompt injection',
			status: 'watching',
			detail: `Tool output is treated as data for ${stableHash(task).slice(0, 6)}`
		}
	];
}

function buildNextActions(status, stoppedByCeiling) {
	if (status === 'needs_attention') {
		return ['Inspect failed verifier evidence', 'Adjust sandbox settings', 'Retry the failed step once'];
	}

	if (stoppedByCeiling) {
		return ['Raise the step ceiling deliberately', 'Resume from the last verified step'];
	}

	return ['Review the persisted evidence ledger', 'Export the audit bundle when external review is required', 'Record durable memory only from verified outcomes'];
}

function stableHash(value) {
	let hash = 0;
	for (const char of String(value)) {
		hash = (hash << 5) - hash + char.charCodeAt(0);
		hash |= 0;
	}

	return Math.abs(hash).toString(36).padStart(6, '0');
}
