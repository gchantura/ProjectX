import { collectOperationsReport } from '$lib/agent/operationsReport.server.js';
import { telemetrySnapshot } from '$lib/server/telemetry.js';

export async function load() {
	let report;
	try { report = await collectOperationsReport({ limit: 100 }); }
	catch (error) {
		report = { status: 'critical', checkedAt: new Date().toISOString(), window: { observedRuns: 0, completedRuns: 0 }, metrics: { successRate: null, needsAttentionRate: null, providerReadyRatio: 0, readyProviders: 0, totalProviders: 0, p95DurationMs: null, totalEstimatedCostUsd: 0, totalTokens: 0 }, workload: { activeRunLeases: 0, pendingRunApprovals: 0 }, dependencies: [], incidents: [{ id: 'operations:unavailable', severity: 'critical', title: 'Operations evidence unavailable', detail: String(error?.message ?? 'The operations aggregate could not be loaded.').slice(0, 220), action: 'Restore Supabase connectivity and rerun readiness diagnostics.' }], recentRuns: [], nextActions: ['Restore Supabase connectivity and rerun readiness diagnostics.'] };
	}
	return { report, processTelemetry: telemetrySnapshot() };
}
