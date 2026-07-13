import { domainModules } from './runtime.js';

const PERMISSION_METADATA = {
	'read-only': {
		access: 'read-only',
		approvalRequired: false,
		externalSideEffect: false,
		description: 'Reads workspace context without writing files or running commands.'
	},
	'artifact-write': {
		access: 'workspace-write',
		approvalRequired: false,
		externalSideEffect: false,
		description: 'Writes audit artifacts inside the bounded .kcevagent artifact directory.'
	},
	'approval-required': {
		access: 'workspace-write',
		approvalRequired: true,
		externalSideEffect: false,
		description: 'Writes source files only after an explicit operator approval record.'
	},
	'workspace-write': {
		access: 'workspace-write',
		approvalRequired: false,
		externalSideEffect: false,
		description: 'Atomically edits source inside approved workspace roots with optimistic concurrency checks.'
	},
	'shell-timeout': {
		access: 'local-command',
		approvalRequired: false,
		externalSideEffect: false,
		description: 'Runs allowlisted validation commands with a hard timeout.'
	}
};

const RISK_ORDER = ['low', 'medium', 'high'];

export function listModuleReadiness() {
	return domainModules.map((module) => {
		const tools = module.tools.map(enrichTool);
		const riskSummary = countRisks(tools);

		return {
			id: module.id,
			name: module.name,
			status: 'installed',
			default: module.id === 'coding',
			toolCount: tools.length,
			riskSummary,
			highestRisk: highestRisk(tools),
			capabilities: [
				'planner context',
				'sandboxed execution',
				'evidence-first verifier',
				'run ledger compatible'
			],
			tools
		};
	});
}

export function getModuleReadiness(id) {
	return listModuleReadiness().find((module) => module.id === id) ?? null;
}

function enrichTool(tool) {
	const metadata = PERMISSION_METADATA[tool.permission] ?? {
		access: tool.permission || 'unknown',
		approvalRequired: false,
		externalSideEffect: true,
		description: 'Permission metadata is not registered for this tool.'
	};

	return {
		...tool,
		...metadata
	};
}

function countRisks(tools) {
	return RISK_ORDER.reduce((summary, risk) => {
		summary[risk] = tools.filter((tool) => tool.risk === risk).length;
		return summary;
	}, {});
}

function highestRisk(tools) {
	return (
		[...tools]
			.sort((left, right) => RISK_ORDER.indexOf(right.risk) - RISK_ORDER.indexOf(left.risk))
			.at(0)?.risk ?? 'low'
	);
}
