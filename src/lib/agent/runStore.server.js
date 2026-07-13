import { randomUUID } from 'node:crypto';
import { createAgentRun, defaultAgentConfig } from './runtime.js';
import { getAgentSettings, settingsToRunConfig } from './settingsStore.server.js';
import { materializeRunTools } from './toolRegistry.server.js';
import { clearSupabaseTestState, createSupabaseRunStore } from './supabaseStore.server.js';
import { resolveProjectContext } from './projectStore.server.js';
import { normalizeAutonomyMode } from './autonomyPolicy.js';

export async function createStoredRun(input = {}) {
	const task = normalizeTaskInput(input.task);
	const config = await normalizeConfigInput(input.config);
	const startedAt = new Date().toISOString();
	const plannedRun = createAgentRun(task, {
		...config,
		runId: `run-${randomUUID()}`,
		startedAt
	});
	const run = await materializeRunTools(plannedRun);

	await persistRun(run);
	return run;
}

export async function persistRun(run) {
	if (!isRunId(run?.id)) {
		throw Object.assign(new Error('Persisted run requires a valid run id.'), { status: 400 });
	}

	await createSupabaseRunStore().persist(run);
	return run;
}

export async function persistRunEvents(runId, events = [], { projectId } = {}) {
	if (!isRunId(runId)) throw Object.assign(new Error('Persisted run events require a valid run id.'), { status: 400 });
	const normalized = normalizeRunEvents(runId, events);
	if (normalized.length === 0) return [];
	await createSupabaseRunStore().persistEvents(runId, normalized, { projectId });
	return normalized;
}

export async function getRunEvents(runId) {
	if (!isRunId(runId)) return undefined;
	return createSupabaseRunStore().listEvents(runId);
}

export async function listStoredRuns({ limit = 20, projectId } = {}) {
	return createSupabaseRunStore().list({ projectId, limit });
}

export async function getStoredRun(id) {
	if (!isRunId(id)) return undefined;
	return createSupabaseRunStore().get(id);
}

export async function getRunLedger(id) {
	if (!isRunId(id)) return undefined;
	const run = await createSupabaseRunStore().get(id);
	return run ? buildLedgerFromRun(run) : undefined;
}

export async function clearStoredRunsForTest() {
	clearSupabaseTestState();
}

export function normalizeTaskInput(task) {
	const value = String(task ?? '').trim();

	if (!value) {
		throw Object.assign(new Error('Task is required.'), { status: 400 });
	}

	if (value.length > 4000) {
		throw Object.assign(new Error('Task must be 4000 characters or fewer.'), { status: 400 });
	}

	return value;
}

export async function normalizeConfigInput(config = {}) {
	const project = await resolveProjectContext(config.projectId);
	const settings = await getAgentSettings({ projectId: project.projectId });
	const defaults = { ...defaultAgentConfig, ...settingsToRunConfig(settings) };
	const stepCeiling = clampInteger(config.stepCeiling ?? defaults.stepCeiling, 1, 12);

	const provider = String(config.provider ?? defaults.provider);
	const requestedModel = String(config.model ?? defaults.model);
	const model = requestedModel === 'kcev-sim-1'
		? provider === 'cloud-openai'
			? String(process.env.KCEV_OPENAI_MODEL ?? 'gpt-5.5')
			: provider === 'cloud-anthropic'
				? String(process.env.KCEV_ANTHROPIC_MODEL ?? 'claude-sonnet-5')
				: provider === 'cloud-gemini'
					? String(process.env.KCEV_GEMINI_MODEL ?? 'gemini-3.5-flash')
					: provider === 'cloud-xai'
						? String(process.env.KCEV_XAI_MODEL ?? 'grok-4.5')
						: provider === 'local-ollama'
							? String(process.env.KCEV_OLLAMA_MODEL ?? 'ornith:9b')
							: requestedModel
		: requestedModel;

	return {
		...defaults,
		...project,
		provider,
		model,
		domain: String(config.domain ?? defaults.domain),
		planningMode: ['single', 'multi-hypothesis'].includes(config.planningMode) ? config.planningMode : defaults.planningMode,
		autonomyMode: normalizeAutonomyMode(config.autonomyMode ?? defaults.autonomyMode),
		stepCeiling,
		costCeilingUsd: clampNumber(config.costCeilingUsd ?? defaults.costCeilingUsd, 0, 100),
		maxTokensPerRun: clampInteger(config.maxTokensPerRun ?? defaults.maxTokensPerRun, 1000, 2000000),
		executionContext: config.executionContext
	};
}

function clampNumber(value, min, max) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return min;
	return Math.min(Math.max(numeric, min), max);
}

function clampInteger(value, min, max) {
	return Math.trunc(clampNumber(value, min, max));
}

function isRunId(id) {
	return typeof id === 'string' && /^run-[a-z0-9-]+$/i.test(id);
}

function normalizeRunEvents(runId, events) {
	return (Array.isArray(events) ? events : []).map((event, index) => ({
		position: Math.max(Number.isInteger(Number(event.position)) ? Number(event.position) : index, 0),
		type: String(event.type ?? event.payload?.type ?? 'event').slice(0, 120),
		payload: sanitizeEventPayload(event.payload ?? event),
		createdAt: validDateString(event.createdAt) ? event.createdAt : new Date().toISOString()
	})).filter((event) => event.type && event.payload?.runId !== '__invalid__');
}

function sanitizeEventPayload(event) {
	const payload = JSON.parse(JSON.stringify(event ?? {}));
	delete payload.position;
	delete payload.createdAt;
	return payload;
}

function validDateString(value) {
	return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function parseArtifactEvidence(evidence) {
	if (typeof evidence !== 'string') return undefined;
	if (evidence.startsWith('artifact:')) return evidence.slice('artifact:'.length);
	if (evidence.startsWith('source-write:')) return evidence.slice('source-write:'.length);
	return undefined;
}

function stableLedgerId(value) {
	return String(value)
		.replace(/[^a-z0-9_-]+/gi, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}

function rowToObject(row) {
	return Object.fromEntries(Object.entries(row));
}

function normalizeLedgerRun(row) {
	return {
		...row,
		step_ceiling: Number(row.step_ceiling),
		cost_ceiling_usd: Number(row.cost_ceiling_usd),
		total_steps: Number(row.total_steps),
		verified_steps: Number(row.verified_steps),
		failed_steps: Number(row.failed_steps),
		remaining_steps: Number(row.remaining_steps),
		estimated_cost_usd: Number(row.estimated_cost_usd)
	};
}

export function buildLedgerFromRun(run) {
	if (!run?.id) return undefined;
	const now = new Date().toISOString();
	const steps = Array.isArray(run.steps) ? run.steps : [];
	return {
		run: {
			id: run.id,
			task: String(run.task ?? ''),
			status: String(run.status ?? 'unknown'),
			provider: String(run.config?.provider ?? ''),
			model: String(run.config?.model ?? ''),
			domain: String(run.config?.domain ?? ''),
			started_at: String(run.startedAt ?? ''),
			ended_at: run.endedAt ?? null,
			step_ceiling: Number(run.config?.stepCeiling) || 0,
			cost_ceiling_usd: Number(run.config?.costCeilingUsd) || 0,
			total_steps: Number(run.summary?.totalSteps) || steps.length,
			verified_steps: Number(run.summary?.verifiedSteps) || steps.filter((step) => step.verification?.verified).length,
			failed_steps: Number(run.summary?.failedSteps) || steps.filter((step) => step.status === 'failed').length,
			remaining_steps: Number(run.summary?.remainingSteps) || steps.filter((step) => !['verified', 'failed'].includes(step.status)).length,
			estimated_cost_usd: Number(run.summary?.estimatedCostUsd) || 0,
			run_json: JSON.stringify(run),
			created_at: String(run.startedAt ?? now),
			updated_at: String(run.endedAt ?? now)
		},
		steps: steps.map((step, index) => ({
			id: `${run.id}:${step.id}`,
			run_id: run.id,
			step_id: String(step.id ?? `step-${index + 1}`),
			position: index,
			role: String(step.role ?? 'executor'),
			title: String(step.title ?? ''),
			description: String(step.description ?? ''),
			status: String(step.status ?? 'unknown'),
			risk: String(step.risk ?? 'medium'),
			tool: String(step.tool ?? step.toolCall?.name ?? ''),
			raw_output: String(step.rawOutput ?? ''),
			started_at_offset_ms: Number(step.startedAtOffsetMs) || 0,
			duration_ms: Number(step.durationMs) || 0,
			step_json: JSON.stringify(step),
			created_at: now,
			updated_at: now
		})),
		toolCalls: steps.map((step) => ({
			id: `${run.id}:${step.id}:tool`,
			run_id: run.id,
			step_id: String(step.id ?? ''),
			name: String(step.toolCall?.name ?? step.tool ?? ''),
			args: step.toolCall?.args ?? {},
			raw_output: String(step.rawOutput ?? ''),
			error: step.status === 'failed' ? String(step.rawOutput ?? '') : null,
			created_at: now
		})),
		verifications: steps.map((step) => ({
			id: `${run.id}:${step.id}:verification`,
			run_id: run.id,
			step_id: String(step.id ?? ''),
			verified: step.verification?.verified === true,
			reason: String(step.verification?.reason ?? ''),
			evidence: Array.isArray(step.verification?.evidence) ? step.verification.evidence : [],
			created_at: now
		})),
		artifacts: steps.flatMap((step) => (Array.isArray(step.verification?.evidence) ? step.verification.evidence : [])
			.map((evidence) => ({ evidence, path: parseArtifactEvidence(evidence) }))
			.filter((artifact) => artifact.path)
			.map((artifact) => ({
				id: `${run.id}:${step.id}:artifact:${stableLedgerId(artifact.path)}`,
				run_id: run.id,
				step_id: String(step.id ?? ''),
				path: artifact.path,
				type: String(artifact.evidence).startsWith('source-write:') ? 'source' : 'artifact',
				metadata: { evidence: artifact.evidence },
				created_at: now
			})))
	};
}
