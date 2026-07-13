import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createAgentRun } from './runtime.js';
import { createConfiguredProvider, isModelBackedProvider } from './providerFactory.server.js';
import { createProviderPlannedRun } from './agentPipeline.server.js';
import { getRunEvents, normalizeTaskInput, persistRun, persistRunEvents } from './runStore.server.js';
import { createSupabaseApprovalStore } from './supabaseStore.server.js';

const APPROVAL_TTL_MS = 30 * 60 * 1000;

export async function createRunPreflight(input = {}, { provider, approvalStore = createSupabaseApprovalStore(), now = new Date(), signal } = {}) {
	const task = normalizeTaskInput(input.task);
	const config = input.config;
	if (!config?.executionContext) throw Object.assign(new Error('Preflight requires an admitted execution context.'), { status: 409, code: 'PREFLIGHT_CONTEXT_REQUIRED' });
	const modelBacked = isModelBackedProvider(config.provider);
	const resolvedProvider = modelBacked ? (provider ?? createConfiguredProvider(config)) : undefined;
	const planned = modelBacked
		? await createProviderPlannedRun(task, config, { provider: resolvedProvider, signal })
		: createAgentRun(task, { ...config, runId: `run-${randomUUID()}`, startedAt: now.toISOString() });
	const run = toAwaitingApproval(planned, now);
	const approvalToken = randomBytes(32).toString('base64url');
	const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
	const planSha256 = fingerprintPlan(run);
	run.preflight = { status: 'awaiting_approval', planSha256, requestedAt: now.toISOString(), expiresAt };
	await persistRun(run);
	const approval = await approvalStore.request({
		projectId: config.projectId,
		runId: run.id,
		planSha256,
		tokenSha256: sha256(approvalToken),
		actor: config.executionContext.actor,
		expiresAt,
		now
	});
	await persistRunEvents(run.id, [{ position: 0, type: 'preflight_created', payload: { type: 'preflight_created', runId: run.id, planSha256, approval: publicApproval(approval), createdAt: now.toISOString() }, createdAt: now.toISOString() }], { projectId: config.projectId });
	return { run, approvalToken, approval: publicApproval(approval) };
}

export async function consumeRunApproval(run, approvalToken, { actor, approvalStore = createSupabaseApprovalStore(), now = new Date() } = {}) {
	validateApprovalToken(run, approvalToken, now);
	const approval = await approvalStore.consume({
		projectId: run.config.projectId,
		runId: run.id,
		planSha256: run.preflight.planSha256,
		tokenSha256: sha256(approvalToken),
		actor: String(actor || run.config.executionContext?.actor || 'operator').slice(0, 160),
		now
	});
	if (!approval?.approved) throw Object.assign(new Error('This plan approval is invalid, expired, or has already been consumed.'), { status: 409, code: 'RUN_APPROVAL_UNAVAILABLE' });
	return publicApproval(approval);
}

export async function rejectRunPreflight(run, { actor, approvalStore = createSupabaseApprovalStore(), now = new Date() } = {}) {
	if (run?.status !== 'awaiting_approval') throw Object.assign(new Error('Run is not awaiting approval.'), { status: 409, code: 'RUN_NOT_AWAITING_APPROVAL' });
	const approval = await approvalStore.reject({ projectId: run.config.projectId, runId: run.id, actor: String(actor || 'operator').slice(0, 160), now });
	if (!approval?.rejected) throw Object.assign(new Error('Pending approval could not be rejected.'), { status: 409, code: 'RUN_APPROVAL_UNAVAILABLE' });
	const rejectedRun = { ...run, status: 'stopped', endedAt: now.toISOString(), preflight: { ...run.preflight, status: 'rejected', rejectedAt: now.toISOString(), approvalId: approval.id }, nextActions: ['Revise the objective or policy and create a new preflight'] };
	await persistRun(rejectedRun);
	const events = await getRunEvents(run.id);
	await persistRunEvents(run.id, [{ position: events?.length ?? 0, type: 'preflight_rejected', payload: { type: 'preflight_rejected', runId: run.id, planSha256: run.preflight.planSha256, approval: publicApproval(approval) }, createdAt: now.toISOString() }], { projectId: run.config.projectId });
	return { run: rejectedRun, approval: publicApproval(approval) };
}

export function validateApprovalToken(run, token, now = new Date()) {
	if (run?.status !== 'awaiting_approval' || run?.preflight?.status !== 'awaiting_approval') throw Object.assign(new Error('Run is not awaiting plan approval.'), { status: 409, code: 'RUN_NOT_AWAITING_APPROVAL' });
	if (!/^[a-zA-Z0-9_-]{40,128}$/.test(String(token ?? ''))) throw Object.assign(new Error('A valid plan approval token is required.'), { status: 400, code: 'RUN_APPROVAL_TOKEN_INVALID' });
	if (run.preflight.expiresAt <= now.toISOString()) throw Object.assign(new Error('Plan approval expired; create a new preflight.'), { status: 409, code: 'RUN_APPROVAL_EXPIRED' });
	const actualPlanHash = fingerprintPlan(run);
	if (!safeEqual(actualPlanHash, run.preflight.planSha256)) throw Object.assign(new Error('The persisted plan changed after review.'), { status: 409, code: 'RUN_PLAN_TAMPERED' });
	return true;
}

export function fingerprintPlan(run) {
	return sha256(canonicalJson({
		runId: run.id,
		task: run.task,
		executionContextSignature: run.config?.executionContext?.signature,
		steps: (run.steps ?? []).map((step) => ({ id: step.id, title: step.title, description: step.description, tool: step.tool, risk: step.risk, dependsOn: step.dependsOn ?? [], evidenceRequired: step.evidenceRequired, toolCall: step.toolCall }))
	}));
}

function toAwaitingApproval(run, now) {
	return {
		...run,
		status: 'awaiting_approval',
		startedAt: run.startedAt ?? now.toISOString(),
		summary: { ...run.summary, verifiedSteps: 0, failedSteps: 0, remainingSteps: run.steps.length },
		steps: run.steps.map((step) => ({ ...step, status: 'planned', startedAtOffsetMs: 0, durationMs: 0, rawOutput: '', verification: { ...step.verification, verified: false, reason: 'Awaiting operator approval of this exact plan.', evidence: [...new Set([...(step.verification?.evidence ?? []), 'preflight:awaiting-approval'])] } })),
		nextActions: ['Review plan scope, risks, and evidence requirements', 'Approve the exact persisted plan or discard it']
	};
}

function publicApproval(approval = {}) {
	return { id: approval.id, runId: approval.runId, planSha256: approval.planSha256, decision: approval.decision, requestedBy: approval.requestedBy, decidedBy: approval.decidedBy ?? null, requestedAt: approval.requestedAt, decidedAt: approval.decidedAt ?? null, expiresAt: approval.expiresAt };
}

function safeEqual(left, right) {
	if (!/^[a-f0-9]{64}$/.test(String(left)) || !/^[a-f0-9]{64}$/.test(String(right))) return false;
	return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function canonicalJson(value) {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}
