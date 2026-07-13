import { collectGovernanceReport } from './governance.server.js';
import { normalizeConfigInput } from './runStore.server.js';
import { getProviderPricing } from './runBudget.server.js';
import { getStoredRun } from './runStore.server.js';
import { collectProjectReadiness } from './projectReadiness.server.js';
import { createExecutionContext, validateExecutionContext } from './executionContext.server.js';

export async function assertRunAdmission(input = {}, deps = {}) {
	const normalizeConfig = deps.normalizeConfig ?? normalizeConfigInput;
	const config = await normalizeConfig({ ...(input.config ?? {}), autonomyMode: input.mode ?? input.config?.autonomyMode });
	return assertConfigAdmission(config, input.mode, deps, { actor: input.actor, correlationId: input.correlationId });
}

export async function assertResumeAdmission(input = {}, deps = {}) {
	const runId = String(input.runId ?? input.resumeRunId ?? '');
	const run = await (deps.getRun ?? getStoredRun)(runId);
	if (!run) throw Object.assign(new Error(`Run not found: ${runId}`), { status: 404, code: 'RUN_NOT_FOUND' });
	const normalizeConfig = deps.normalizeConfig ?? normalizeConfigInput;
	const config = await normalizeConfig(run.config ?? {});
	return { ...(await assertConfigAdmission(config, input.mode, deps, { existingContext: run.config?.executionContext })), run };
}

async function assertConfigAdmission(config, mode, deps, contextInput = {}) {
	const collectReadiness = deps.collectReadiness ?? collectProjectReadiness;
	const readiness = await collectReadiness(config.projectId);
	if (readiness.status === 'blocked') {
		throw Object.assign(new Error(readiness.blockers?.[0] || 'Project readiness checks blocked this run.'), {
			status: 409,
			code: 'RUN_PROJECT_BLOCKED',
			readiness
		});
	}
	const collectGovernance = deps.collectGovernance ?? collectGovernanceReport;
	const governance = await collectGovernance({
		selectedProviderId: config.provider,
		selectedModel: config.model,
		mode: mode ?? 'interactive'
	});
	if (!governance.runGate.canStartRun) {
		const error = Object.assign(new Error(governance.runGate.reason || 'Run blocked by governance policy.'), {
			status: 409,
			code: 'RUN_GOVERNANCE_BLOCKED',
			governance
		});
		throw error;
	}
	const pricing = (deps.getPricing ?? getProviderPricing)(config.provider);
	if (String(config.provider).startsWith('cloud-') && Number(config.costCeilingUsd) > 0 && !pricing.configured) {
		throw Object.assign(new Error(`Cost ceiling cannot be enforced until pricing is configured for ${config.provider}.`), { status: 409, code: 'RUN_PRICING_UNCONFIGURED' });
	}
	const buildContext = deps.createContext ?? createExecutionContext;
	const verifyContext = deps.validateContext ?? validateExecutionContext;
	const executionContext = contextInput.existingContext
		? contextInput.existingContext
		: buildContext({ config, readiness, actor: contextInput.actor, correlationId: contextInput.correlationId });
	const validation = verifyContext(executionContext, { config, readiness });
	if (!validation.valid) throw Object.assign(new Error(validation.reason), { status: 409, code: 'RUN_CONTEXT_INVALID', validation });
	return { config: { ...config, executionContext }, governance, readiness, executionContext };
}
