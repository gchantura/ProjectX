import { collectDiagnostics } from './diagnostics.server.js';
import { listProviderReadiness } from './providerRegistry.server.js';
import { listStoredRuns } from './runStore.server.js';

const DEFAULT_SLOS = {
	successRate: 0.9,
	needsAttentionRate: 0.1,
	providerReadyRatio: 0.2,
	eventReplayRequired: true
};

export async function collectOperationsReport(input = {}, deps = {}) {
	const limit = clampInteger(input.limit ?? 50, 1, 100);
	const [runs, diagnostics, providers] = await Promise.all([
		deps.runs ?? listStoredRuns({ limit }),
		deps.diagnostics ?? collectDiagnostics(deps.diagnosticsOptions ?? {}),
		deps.providers ?? listProviderReadiness()
	]);
	return evaluateOperationsReport({
		runs,
		diagnostics,
		providers,
		slos: { ...DEFAULT_SLOS, ...(input.slos ?? {}) },
		now: input.now ?? new Date(),
		limit
	});
}

export function evaluateOperationsReport({ runs = [], diagnostics = {}, providers = [], slos = DEFAULT_SLOS, now = new Date(), limit = runs.length }) {
	const completedRuns = runs.filter((run) => ['verified', 'needs_attention', 'stopped'].includes(run.status));
	const verifiedRuns = runs.filter((run) => run.status === 'verified');
	const needsAttentionRuns = runs.filter((run) => run.status === 'needs_attention');
	const stoppedRuns = runs.filter((run) => run.status === 'stopped');
	const total = completedRuns.length;
	const successRate = total ? verifiedRuns.length / total : null;
	const needsAttentionRate = total ? needsAttentionRuns.length / total : null;
	const readyProviders = providers.filter((provider) => provider.ready);
	const providerReadyRatio = providers.length ? readyProviders.length / providers.length : 0;
	const durations = completedRuns.map(runDurationMs).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	const p95DurationMs = percentile(durations, 0.95);
	const incidents = [
		...sloIncidents({ total, successRate, needsAttentionRate, providerReadyRatio, slos, diagnostics }),
		...runIncidents(needsAttentionRuns, stoppedRuns),
		...providerIncidents(providers)
	];
	const severity = incidents.some((incident) => incident.severity === 'critical')
		? 'critical'
		: incidents.some((incident) => incident.severity === 'warning') ? 'warning' : 'healthy';
	return {
		status: severity,
		checkedAt: now.toISOString(),
		window: { requestedRuns: limit, observedRuns: runs.length, completedRuns: total },
		slos: {
			successRateTarget: slos.successRate,
			needsAttentionRateTarget: slos.needsAttentionRate,
			providerReadyRatioTarget: slos.providerReadyRatio,
			eventReplayRequired: slos.eventReplayRequired
		},
		metrics: {
			successRate,
			needsAttentionRate,
			stoppedRate: total ? stoppedRuns.length / total : null,
			providerReadyRatio,
			readyProviders: readyProviders.length,
			totalProviders: providers.length,
			p95DurationMs,
			totalEstimatedCostUsd: roundCurrency(runs.reduce((sum, run) => sum + (Number(run.summary?.estimatedCostUsd) || 0), 0)),
			totalTokens: runs.reduce((sum, run) => sum + (Number(run.summary?.totalTokens) || 0), 0)
		},
		dependencies: dependencySummary(diagnostics, providers),
		workload: {
			activeRunLeases: Number(diagnostics.storage?.details?.activeRunLeases) || 0,
			pendingRunApprovals: Number(diagnostics.storage?.details?.pendingRunApprovals) || 0
		},
		incidents,
		recentRuns: runs.slice(0, 8).map(summarizeRun),
		nextActions: nextActions(severity, incidents)
	};
}

function dependencySummary(diagnostics, providers) {
	const checks = [diagnostics.storage, diagnostics.identityDirectory, diagnostics.audit, diagnostics.rateLimiting, diagnostics.federation, diagnostics.memory, diagnostics.security, diagnostics.events, diagnostics.localModels].filter(Boolean).map((item) => ({ id: item.id, status: item.status, message: item.message }));
	return [...checks, ...providers.map((provider) => ({ id: `provider:${provider.id}`, status: provider.ready ? 'passed' : 'warning', message: `${provider.name}: ${provider.nextAction}` }))];
}

function sloIncidents({ total, successRate, needsAttentionRate, providerReadyRatio, slos, diagnostics }) {
	const incidents = [];
	if (total === 0) {
		incidents.push({ id: 'slo:no-runs', severity: 'warning', title: 'No completed runs in the observed window', detail: 'SLOs need at least one completed run before reliability can be proven.', action: 'Complete a bounded run and confirm the ledger/event timeline records it.' });
	}
	if (successRate !== null && successRate < slos.successRate) {
		incidents.push({ id: 'slo:success-rate', severity: 'critical', title: 'Run success SLO breached', detail: `Observed ${(successRate * 100).toFixed(1)}% verified runs, below target ${(slos.successRate * 100).toFixed(1)}%.`, action: 'Review failed run ledgers, verifier evidence, provider probes, and rollback events before raising concurrency.' });
	}
	if (needsAttentionRate !== null && needsAttentionRate > slos.needsAttentionRate) {
		incidents.push({ id: 'slo:needs-attention', severity: 'critical', title: 'Needs-attention rate SLO breached', detail: `Observed ${(needsAttentionRate * 100).toFixed(1)}% runs requiring operator attention, above target ${(slos.needsAttentionRate * 100).toFixed(1)}%.`, action: 'Triage escalated steps and add validation or provider guardrails for repeated failure modes.' });
	}
	if (providerReadyRatio < slos.providerReadyRatio) {
		incidents.push({ id: 'slo:provider-readiness', severity: 'critical', title: 'Provider readiness SLO breached', detail: `Only ${(providerReadyRatio * 100).toFixed(1)}% of providers are ready.`, action: 'Run maintenance probes and restore at least one local and one cloud execution provider where credentials are available.' });
	}
	if (slos.eventReplayRequired && diagnostics.events?.status !== 'passed') {
		incidents.push({ id: 'slo:event-replay', severity: 'warning', title: 'Event replay is not fully proven', detail: diagnostics.events?.message ?? 'Event replay diagnostic is unavailable.', action: 'Complete a run and verify persisted event timelines before relying on audit playback.' });
	}
	return incidents;
}

function runIncidents(needsAttentionRuns, stoppedRuns) {
	return [
		...needsAttentionRuns.slice(0, 3).map((run) => ({ id: `run:${run.id}:needs-attention`, severity: 'critical', title: 'Run needs operator attention', detail: summarizeTask(run.task), action: `Open run ${run.id}, inspect failed step evidence, and either resume or resolve the underlying tool/provider failure.` })),
		...stoppedRuns.slice(0, 2).map((run) => ({ id: `run:${run.id}:stopped`, severity: 'warning', title: 'Run was stopped before completion', detail: summarizeTask(run.task), action: `Resume run ${run.id} from the persisted ledger or archive it with an incident note.` }))
	];
}

function providerIncidents(providers) {
	return providers
		.filter((provider) => !provider.ready)
		.slice(0, 4)
		.map((provider) => ({ id: `provider:${provider.id}`, severity: 'warning', title: `${provider.name} blocked`, detail: provider.nextAction, action: `Run readiness probes for ${provider.id} after configuring credentials or local model availability.` }));
}

function nextActions(severity, incidents) {
	if (severity === 'healthy') return ['Maintain scheduled maintenance probes', 'Continue exporting audit bundles for critical runs'];
	return [...new Set(incidents.map((incident) => incident.action))].slice(0, 6);
}

function summarizeRun(run) {
	return {
		id: run.id,
		status: run.status,
		provider: run.config?.provider,
		model: run.config?.model,
		startedAt: run.startedAt,
		durationMs: runDurationMs(run),
		verifiedSteps: Number(run.summary?.verifiedSteps) || 0,
		failedSteps: Number(run.summary?.failedSteps) || 0,
		estimatedCostUsd: Number(run.summary?.estimatedCostUsd) || 0,
		task: summarizeTask(run.task)
	};
}

function summarizeTask(task) {
	return String(task ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function runDurationMs(run) {
	const start = Date.parse(run.startedAt);
	const end = Date.parse(run.endedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	return end - start;
}

function percentile(values, percentileValue) {
	if (!values.length) return null;
	const index = Math.ceil(values.length * percentileValue) - 1;
	return values[Math.min(Math.max(index, 0), values.length - 1)];
}

function clampInteger(value, min, max) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return min;
	return Math.trunc(Math.min(Math.max(numeric, min), max));
}

function roundCurrency(value) {
	return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000;
}
