import { collectDiagnostics } from './diagnostics.server.js';
import { listProviderReadiness, runProviderReadinessProbe } from './providerRegistry.server.js';
import { incrementMetric, logEvent, observeMetric } from '../server/telemetry.js';

const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function runMaintenanceAutomation(input = {}, deps = {}) {
	const now = deps.now ?? new Date();
	const started = Date.now();
	const staleAfterMs = clampInteger(input.staleAfterMinutes, 5, 60 * 24 * 30, DEFAULT_STALE_AFTER_MS / 60000) * 60000;
	const diagnosticsCollector = deps.collectDiagnostics ?? collectDiagnostics;
	const listProviders = deps.listProviderReadiness ?? listProviderReadiness;
	const probeProvider = deps.runProviderReadinessProbe ?? runProviderReadinessProbe;
	const before = await diagnosticsCollector({ now });
	const providers = await listProviders();
	const selected = selectProviders(providers, input, now, staleAfterMs);
	const probes = [];
	for (const provider of selected) {
		const action = { providerId: provider.id, previousStatus: provider.status, previousCheckedAt: provider.checkedAt, attempted: true };
		try {
			const result = await probeProvider(provider.id);
			probes.push({ ...action, status: result?.status ?? 'unknown', ready: result?.ready === true, reliabilityScore: result?.reliabilityScore ?? 0, message: result?.nextAction ?? 'Probe completed.' });
		} catch (error) {
			probes.push({ ...action, status: 'failed', ready: false, reliabilityScore: 0, message: String(error?.message ?? 'Provider probe failed.').slice(0, 220) });
		}
	}
	const after = await diagnosticsCollector({ now: new Date(now.getTime() + Math.max(Date.now() - started, 0)) });
	const status = after.summary.failed > 0 ? 'completed_with_failures' : probes.some((probe) => !probe.ready) || after.summary.warnings > 0 ? 'completed_with_warnings' : 'completed';
	const report = {
		id: `maintenance-${now.toISOString()}`,
		status,
		startedAt: now.toISOString(),
		durationMs: Math.max(Date.now() - started, 0),
		policy: {
			staleAfterMinutes: Math.round(staleAfterMs / 60000),
			probeMode: input.probeProviders === true ? 'all-requested' : input.providerIds?.length ? 'selected' : 'stale'
		},
		before: summarizeDiagnostics(before),
		after: summarizeDiagnostics(after),
		probes,
		nextActions: nextActions(status, probes, after)
	};
	incrementMetric('kcev_maintenance_runs_total', { status });
	observeMetric('kcev_maintenance_duration_ms', report.durationMs, { status });
	logEvent(status === 'completed_with_failures' ? 'warn' : 'info', 'maintenance.completed', { status, probes: probes.length, failedChecks: after.summary.failed, warnings: after.summary.warnings });
	return report;
}

function selectProviders(providers, input, now, staleAfterMs) {
	const requested = new Set((Array.isArray(input.providerIds) ? input.providerIds : []).map((id) => String(id)));
	return providers.filter((provider) => {
		if (requested.size > 0) return requested.has(provider.id);
		if (input.probeProviders === true) return true;
		if (!provider.checkedAt) return true;
		return now.getTime() - new Date(provider.checkedAt).getTime() >= staleAfterMs;
	});
}

function summarizeDiagnostics(diagnostics) {
	return {
		status: diagnostics.status,
		checkedAt: diagnostics.checkedAt,
		summary: diagnostics.summary,
		storage: diagnostics.storage.status,
		memory: diagnostics.memory.status,
		security: diagnostics.security.status,
		eventLog: diagnostics.events.status,
		localModels: diagnostics.localModels.status,
		providersReady: diagnostics.providers.readyCount,
		providersTotal: diagnostics.providers.total
	};
}

function nextActions(status, probes, diagnostics) {
	const actions = [];
	if (status === 'completed') actions.push('No operator action required.');
	if (diagnostics.summary.failed > 0) actions.push('Review failed diagnostics before admitting production traffic.');
	if (probes.some((probe) => !probe.ready)) actions.push('Resolve blocked provider probes or select a ready fallback provider.');
	if (diagnostics.localModels.status !== 'passed') actions.push('Start Ollama and install at least one local model for local execution readiness.');
	if (actions.length === 0) actions.push('Review warnings and rerun maintenance after remediation.');
	return actions;
}

function clampInteger(value, min, max, fallback) {
	const parsed = Number(value);
	return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}
