import { randomUUID } from 'node:crypto';
import { createAgentRun } from './runtime.js';
import { getRunEvents, getStoredRun, normalizeConfigInput, normalizeTaskInput, persistRun, persistRunEvents } from './runStore.server.js';
import { executeAgentTool, materializeRunStep } from './toolRegistry.server.js';
import { createProviderPlannedRun, createProviderStepMaterializer } from './agentPipeline.server.js';
import { recordVerifiedRunMemory } from './memoryStore.server.js';
import { calculateUsageCost, evaluateRunBudget } from './runBudget.server.js';
import { createConfiguredProvider, isModelBackedProvider } from './providerFactory.server.js';
import { incrementMetric, logEvent, observeMetric } from '../server/telemetry.js';
import { acquireRunLease, heartbeatRunLease, publicLease, releaseRunLease } from './runLease.server.js';

const STEP_DELAY_MS = 180;
const MAX_STEP_RETRIES = 1;

export function createRunEventStream(input = {}, { signal, lease, leaseStore } = {}) {
	return createEventStream(streamRunEvents(input, { signal, lease, leaseStore }));
}

export function createResumeEventStream(input = {}, { signal, lease, leaseStore } = {}) {
	return createEventStream(streamResumeEvents(input, { signal, lease, leaseStore }));
}

export function createApprovedRunEventStream(input = {}, { signal, lease, leaseStore, run, approval, materializeStep, provider } = {}) {
	return createEventStream(streamApprovedRunEvents(input, { signal, lease, leaseStore, run, approval, materializeStep, provider }));
}

function createEventStream(events) {
	const encoder = new TextEncoder();

	return new ReadableStream({
		async start(controller) {
			try {
				for await (const event of events) {
					controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
				}
				controller.close();
			} catch (error) {
				controller.enqueue(
					encoder.encode(
						`${JSON.stringify({
							type: 'error',
							message: error?.message || 'Unable to stream run.'
						})}\n`
					)
				);
				controller.close();
			}
		}
	});
}

export async function* streamRunEvents(input = {}, { signal, materializeStep, provider, lease, leaseStore } = {}) {
	const task = normalizeTaskInput(input.task);
	const config = await normalizeConfigInput(input.config);
	const isModelBacked = isModelBackedProvider(config.provider);
	const resolvedProvider = isModelBacked ? (provider ?? createConfiguredProvider(config)) : undefined;
	const plannedRun = isModelBacked
		? await createProviderPlannedRun(task, config, { provider: resolvedProvider, signal })
		: createAgentRun(task, { ...config, runId: `run-${randomUUID()}`, startedAt: new Date().toISOString() });
	const executeStep = materializeStep ?? (isModelBacked ? createProviderStepMaterializer({ provider: resolvedProvider, signal }) : materializeRunStep);
	const streamingRun = {
		...plannedRun,
		status: 'running',
		summary: {
			...plannedRun.summary,
			verifiedSteps: 0,
			failedSteps: 0
		},
		steps: plannedRun.steps.map((step) => ({
			...step,
			status: 'planned',
			rawOutput: ''
		}))
	};
	await persistRun(streamingRun);
	const activeLease = lease ?? await acquireRunLease(streamingRun.id, {
		projectId: streamingRun.config.projectId,
		ownerId: `worker:${streamingRun.config.executionContext?.correlationId ?? randomUUID()}`,
		store: leaseStore
	});
	const recordEvent = createRunEventRecorder(streamingRun.id, streamingRun.config.projectId);
	try {
		yield await recordEvent({ type: 'run_started', run: streamingRun, lease: publicLease(activeLease) });
		yield* executeRunSteps(plannedRun, {
			signal,
			materializeStep: executeStep,
			completedSteps: [],
			recordEvent,
			operation: 'new',
			lease: activeLease,
			leaseStore
		});
	} finally {
		await releaseRunLease(activeLease, { store: leaseStore }).catch((error) => logEvent('warn', 'agent_run.lease_release_failed', { runId: activeLease.runId, error: error?.message }));
	}
}

export async function* streamApprovedRunEvents(input = {}, { signal, materializeStep, provider, lease, leaseStore, run, approval } = {}) {
	const runId = normalizeResumeRunId(input.preflightRunId ?? input.runId);
	const storedRun = run ?? await getStoredRun(runId);
	if (!storedRun) throw Object.assign(new Error(`Run not found: ${runId}`), { status: 404 });
	if (storedRun.status !== 'awaiting_approval' || storedRun.preflight?.status !== 'awaiting_approval') throw Object.assign(new Error('Run is not awaiting approval.'), { status: 409, code: 'RUN_NOT_AWAITING_APPROVAL' });
	const config = input.admittedConfig ?? storedRun.config;
	const modelBacked = isModelBackedProvider(config.provider);
	const resolvedProvider = modelBacked ? (provider ?? createConfiguredProvider(config)) : undefined;
	const executeStep = materializeStep ?? (modelBacked ? createProviderStepMaterializer({ provider: resolvedProvider, signal }) : materializeRunStep);
	const approvedRun = {
		...storedRun,
		config,
		status: 'running',
		preflight: { ...storedRun.preflight, status: 'approved', approvedAt: approval?.decidedAt ?? new Date().toISOString(), approvalId: approval?.id ?? null },
		summary: { ...storedRun.summary, verifiedSteps: 0, failedSteps: 0, remainingSteps: storedRun.steps.length },
		steps: storedRun.steps.map((step) => ({ ...step, status: 'planned', durationMs: 0, rawOutput: '' })),
		nextActions: ['Execute the approved persisted plan', 'Inspect independent verifier evidence']
	};
	await persistRun(approvedRun);
	const activeLease = lease ?? await acquireRunLease(runId, { projectId: config.projectId, ownerId: `worker:${config.executionContext?.correlationId ?? randomUUID()}`, store: leaseStore });
	const priorEvents = await getRunEvents(runId);
	const recordEvent = createRunEventRecorder(runId, config.projectId, priorEvents?.length ?? 0);
	try {
		yield await recordEvent({ type: 'run_started', run: approvedRun, lease: publicLease(activeLease), approval });
		yield* executeRunSteps(approvedRun, { signal, materializeStep: executeStep, completedSteps: [], recordEvent, operation: 'approved', lease: activeLease, leaseStore });
	} finally {
		await releaseRunLease(activeLease, { store: leaseStore }).catch((error) => logEvent('warn', 'agent_run.lease_release_failed', { runId: activeLease.runId, error: error?.message }));
	}
}

export async function* streamResumeEvents(
	input = {},
	{ signal, materializeStep, provider, lease, leaseStore } = {}
) {
	const resumeRunId = normalizeResumeRunId(input.runId ?? input.resumeRunId);
	const storedRun = await getStoredRun(resumeRunId);

	if (!storedRun) {
		throw Object.assign(new Error(`Run not found: ${resumeRunId}`), { status: 404 });
	}
	const runConfig = input.admittedConfig ?? storedRun.config;
	const isModelBacked = isModelBackedProvider(runConfig?.provider);
	const resolvedProvider = isModelBacked ? (provider ?? createConfiguredProvider(runConfig)) : undefined;
	const executeStep = materializeStep ?? (isModelBacked ? createProviderStepMaterializer({ provider: resolvedProvider, signal }) : materializeRunStep);

	const completedSteps = verifiedPrefix(storedRun.steps);
	const resumableRun = {
		...storedRun,
		config: runConfig,
		status: 'running',
		summary: {
			...storedRun.summary,
			verifiedSteps: completedSteps.length,
			failedSteps: 0,
			remainingSteps: storedRun.steps.length - completedSteps.length
		},
		steps: [
			...completedSteps,
			...storedRun.steps.slice(completedSteps.length).map((step) => ({
				...step,
				status: 'planned',
				rawOutput: '',
				verification: {
					...step.verification,
					verified: true,
					reason: 'Queued for resume from persisted run ledger.',
					evidence: [...new Set([...(step.verification.evidence ?? []), 'resume:queued'])]
				}
			}))
		],
		nextActions: ['Continue from persisted ledger', 'Verify resumed step evidence']
	};
	const activeLease = lease ?? await acquireRunLease(resumableRun.id, {
		projectId: resumableRun.config.projectId,
		ownerId: `worker:${resumableRun.config.executionContext?.correlationId ?? randomUUID()}`,
		store: leaseStore
	});

	const priorEvents = await getRunEvents(resumableRun.id);
	const recordEvent = createRunEventRecorder(resumableRun.id, resumableRun.config.projectId, priorEvents?.length ?? 0);
	try {
		yield await recordEvent({
			type: 'run_resumed',
			run: resumableRun,
			lease: publicLease(activeLease),
			resume: {
				fromRunId: storedRun.id,
				skippedVerifiedSteps: completedSteps.length,
				remainingSteps: resumableRun.summary.remainingSteps
			}
		});

		yield* executeRunSteps(resumableRun, {
			signal,
			materializeStep: executeStep,
			completedSteps,
			startIndex: completedSteps.length,
			recordEvent,
			operation: 'resume',
			lease: activeLease,
			leaseStore
		});
	} finally {
		await releaseRunLease(activeLease, { store: leaseStore }).catch((error) => logEvent('warn', 'agent_run.lease_release_failed', { runId: activeLease.runId, error: error?.message }));
	}
}

async function* executeRunSteps(
	plannedRun,
	{ signal, materializeStep, completedSteps = [], startIndex = 0, recordEvent = async (event) => event, operation = 'new', lease, leaseStore } = {}
) {
	const streamingRun = {
		...plannedRun,
		status: 'running',
		steps: plannedRun.steps
	};

	for (const step of plannedRun.steps.slice(startIndex)) {
		if (lease) await heartbeatRunLease(lease, { store: leaseStore });
		if (signal?.aborted) {
			const stoppedRun = await persistStoppedRun(streamingRun, completedSteps, operation);
			yield await recordEvent({ type: 'run_stopped', run: stoppedRun });
			return;
		}

		const budget = evaluateRunBudget(plannedRun, completedSteps);
		if (!budget.allowed) {
			const budgetStep = budgetFailureStep(step, budget);
			completedSteps.push(budgetStep);
			yield await recordEvent({ type: 'step_escalated', runId: plannedRun.id, step: budgetStep, budget });
			break;
		}

		yield await recordEvent({ type: 'step_started', runId: plannedRun.id, step: { ...step, status: 'running' } });
		await delay(STEP_DELAY_MS, signal);

		if (signal?.aborted) {
			const stoppedRun = await persistStoppedRun(streamingRun, completedSteps, operation);
			yield await recordEvent({ type: 'run_stopped', run: stoppedRun });
			return;
		}

		let materializedStep = await materializeStep(step, plannedRun.config, { completedSteps: [...completedSteps] });
		yield await recordEvent({ type: 'step_completed', runId: plannedRun.id, step: materializedStep });

		if (materializedStep.status === 'failed') {
			for (let attempt = 1; attempt <= MAX_STEP_RETRIES; attempt += 1) {
				if (lease) await heartbeatRunLease(lease, { store: leaseStore });
				const retryingStep = markStepRetrying(materializedStep, attempt);
				yield await recordEvent({ type: 'step_retrying', runId: plannedRun.id, step: retryingStep, attempt });
				await delay(STEP_DELAY_MS, signal);

				if (signal?.aborted) {
					const stoppedRun = await persistStoppedRun(streamingRun, completedSteps, operation);
					yield await recordEvent({ type: 'run_stopped', run: stoppedRun });
					return;
				}

				materializedStep = await materializeStep(step, plannedRun.config, { completedSteps: [...completedSteps] });
				yield await recordEvent({ type: 'step_completed', runId: plannedRun.id, step: materializedStep, attempt });

				if (materializedStep.status !== 'failed') break;
			}
		}

		if (materializedStep.status === 'failed') {
			const rollback = await rollbackLatestCheckpoint(step, completedSteps, plannedRun.config);
			if (rollback) {
				materializedStep = attachRollbackEvidence(materializedStep, rollback);
				yield await recordEvent({ type: 'step_rolled_back', runId: plannedRun.id, step: materializedStep, rollback });
			}
			materializedStep = escalateFailedStep(materializedStep);
			yield await recordEvent({ type: 'step_escalated', runId: plannedRun.id, step: materializedStep });
		}

		completedSteps.push(materializedStep);

		if (materializedStep.status === 'failed') {
			break;
		}
	}

	const finalRun = finalizeRun(plannedRun, completedSteps);
	await persistRun(finalRun);
	await recordVerifiedRunMemory(finalRun);
	recordRunTelemetry(finalRun, operation);
	yield await recordEvent({ type: 'run_completed', run: finalRun });
}

function createRunEventRecorder(runId, projectId, startPosition = 0) {
	let position = startPosition;
	return async function recordEvent(event) {
		const storedEvent = { position, type: event.type, payload: event, createdAt: new Date().toISOString() };
		position += 1;
		await persistRunEvents(runId, [storedEvent], { projectId });
		return event;
	};
}

async function rollbackLatestCheckpoint(failedStep, completedSteps, config) {
	if (failedStep.tool !== 'run_validation') return undefined;
	for (const step of [...completedSteps].reverse()) {
		const evidence = step.verification?.evidence ?? [];
		const checkpoint = evidence.find((item) => String(item).startsWith('checkpoint:'));
		if (!checkpoint) continue;
		return executeAgentTool({ name: 'rollback_checkpoint', args: { checkpointId: checkpoint.slice('checkpoint:'.length) } }, config);
	}
	return undefined;
}

function attachRollbackEvidence(step, rollback) {
	return {
		...step,
		rawOutput: `${step.rawOutput}\nRecovery: ${rollback.output}`,
		verification: {
			...step.verification,
			reason: `${step.verification.reason} Workspace recovery ${rollback.ok ? 'completed' : 'failed'}.`,
			evidence: [...step.verification.evidence, ...rollback.evidence]
		}
	};
}

function markStepRetrying(step, attempt) {
	return {
		...step,
		status: 'retrying',
		rawOutput: `${step.rawOutput}\nRetrying failed step (attempt ${attempt}/${MAX_STEP_RETRIES}).`,
		verification: {
			...step.verification,
			reason: `${step.verification.reason} Retrying once before escalation.`,
			evidence: [...step.verification.evidence, `retry:attempt-${attempt}`]
		}
	};
}

function escalateFailedStep(step) {
	return {
		...step,
		status: 'failed',
		rawOutput: `${step.rawOutput}\nEscalated after ${MAX_STEP_RETRIES} retry attempt(s).`,
		verification: {
			...step.verification,
			verified: false,
			reason: `${step.verification.reason} Escalated to operator after bounded retry.`,
			evidence: [...step.verification.evidence, 'retry:exhausted', 'escalation:user-required']
		}
	};
}

function finalizeRun(plannedRun, completedSteps) {
	const endedAt = new Date().toISOString();
	const failedSteps = completedSteps.filter((step) => step.status === 'failed').length;
	const verifiedSteps = completedSteps.filter((step) => step.status === 'verified').length;
	const remainingSteps = plannedRun.steps.length - completedSteps.length;
	const status = failedSteps > 0 ? 'needs_attention' : remainingSteps > 0 ? plannedRun.status : 'verified';
	const plannerUsage = plannedRun.providerTrace?.planner?.usage ?? {
		inputTokens: plannedRun.summary?.inputTokens,
		outputTokens: plannedRun.summary?.outputTokens,
		totalTokens: plannedRun.summary?.totalTokens
	};
	const verifierUsage = completedSteps.reduce(
		(accumulator, step) => addUsage(accumulator, step.providerTrace?.verifier?.usage),
		{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }
	);
	const usage = addUsage(plannerUsage, verifierUsage);

	return {
		...plannedRun,
		status,
		endedAt,
		summary: {
			...plannedRun.summary,
			verifiedSteps,
			failedSteps,
			remainingSteps
			,inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			totalTokens: usage.totalTokens,
			estimatedCostUsd: calculateUsageCost(usage, process.env, plannedRun.config?.provider)
		},
		steps: [
			...completedSteps,
			...plannedRun.steps.slice(completedSteps.length).map((step) => ({
				...step,
				status: 'planned',
				rawOutput: ''
			}))
		]
	};
}

function budgetFailureStep(step, budget) {
	return {
		...step, status: 'failed', durationMs: 0,
		rawOutput: budget.reason,
		verification: { verified: false, reason: `${budget.reason} Execution stopped before the next provider/tool step.`, evidence: ['budget:enforced', `tokens:${budget.usage.totalTokens}`, `cost-usd:${budget.costUsd}`] }
	};
}

function addUsage(left = {}, right = {}) {
	return {
		inputTokens: (Number(left.inputTokens) || 0) + (Number(right.inputTokens) || 0),
		outputTokens: (Number(left.outputTokens) || 0) + (Number(right.outputTokens) || 0),
		totalTokens: (Number(left.totalTokens) || 0) + (Number(right.totalTokens) || 0)
	};
}

async function persistStoppedRun(plannedRun, completedSteps, operation = 'new') {
	const stoppedRun = {
		...plannedRun,
		status: 'stopped',
		endedAt: new Date().toISOString(),
		summary: {
			...plannedRun.summary,
			verifiedSteps: completedSteps.filter((step) => step.status === 'verified').length,
			failedSteps: completedSteps.filter((step) => step.status === 'failed').length,
			remainingSteps: plannedRun.steps.length - completedSteps.length
		},
		steps: [
			...completedSteps,
			...plannedRun.steps.slice(completedSteps.length).map((step) => ({
				...step,
				status: 'stopped',
				rawOutput: 'Stopped by operator before execution completed.',
				verification: {
					...step.verification,
					verified: false,
					reason: 'Stopped by operator.',
					evidence: [...step.verification.evidence, 'operator:stopped']
				}
			}))
		],
		nextActions: ['Review completed step evidence', 'Resume from the last verified step']
	};

	await persistRun(stoppedRun);
	recordRunTelemetry(stoppedRun, operation);
	return stoppedRun;
}

function recordRunTelemetry(run, operation) {
	const provider = String(run.config?.provider ?? 'unknown').slice(0, 64);
	const status = String(run.status ?? 'unknown').slice(0, 32);
	const labels = { provider, status, operation };
	incrementMetric('kcev_agent_runs_total', labels);
	for (const step of run.steps ?? []) incrementMetric('kcev_agent_steps_total', { provider, status: String(step.status ?? 'unknown').slice(0, 32) });
	incrementMetric('kcev_agent_tokens_total', { provider, direction: 'input' }, Number(run.summary?.inputTokens) || 0);
	incrementMetric('kcev_agent_tokens_total', { provider, direction: 'output' }, Number(run.summary?.outputTokens) || 0);
	observeMetric('kcev_agent_run_duration_ms', Math.max(Date.now() - new Date(run.startedAt).getTime(), 0), labels);
	observeMetric('kcev_agent_estimated_cost_usd', Number(run.summary?.estimatedCostUsd) || 0, { provider });
	logEvent(status === 'needs_attention' ? 'warn' : 'info', 'agent_run.completed', {
		runId: run.id, provider, model: run.config?.model, status, operation,
		verifiedSteps: run.summary?.verifiedSteps, failedSteps: run.summary?.failedSteps,
		totalTokens: run.summary?.totalTokens, estimatedCostUsd: run.summary?.estimatedCostUsd
	});
}

function verifiedPrefix(steps = []) {
	const prefix = [];

	for (const step of steps) {
		if (step.status !== 'verified') break;
		prefix.push(step);
	}

	return prefix;
}

function normalizeResumeRunId(id) {
	const value = String(id ?? '').trim();

	if (!/^run-[a-z0-9-]+$/i.test(value)) {
		throw Object.assign(new Error('A valid run id is required to resume.'), { status: 400 });
	}

	return value;
}

function delay(ms, signal) {
	if (signal?.aborted) return Promise.resolve();

	return new Promise((resolve) => {
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true }
		);
	});
}
