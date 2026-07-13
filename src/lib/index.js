export {
	capabilityBadges,
	createAgentRun,
	defaultAgentConfig,
	domainModules,
	validateToolCall
} from './agent/runtime.js';

export const workflowSteps = [
	{
		title: 'Read the operating layer',
		detail: 'Start with manifest, policy, architecture, and the generated project map before opening broad source context.',
		status: 'Ready'
	},
	{
		title: 'Assess change complexity',
		detail: 'Use the canonical rubric to decide whether a change is trivial, local, structural, or approval-gated.',
		status: 'Guarded'
	},
	{
		title: 'Implement with narrow scope',
		detail: 'Keep product code separate from AI tooling and prefer small, verifiable changes inside existing boundaries.',
		status: 'Active'
	},
	{
		title: 'Sync and validate',
		detail: 'Regenerate derived agent artifacts, run contract checks, and finish with package validation.',
		status: 'Required'
	}
];

export const qualityGates = [
	'npm run ai:sync',
	'npm run ai:validate',
	'npm run prepack'
];

export const projectSignals = [
	{ label: 'Source roots', value: 'src, static, tools' },
	{ label: 'Product boundary', value: 'src/routes and src/lib' },
	{ label: 'Generated map', value: 'PROJECT_MAP.md' },
	{ label: 'MCP entry', value: 'npm run mcp:project' }
];
