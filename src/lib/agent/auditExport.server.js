import { createHash } from 'node:crypto';
import { collectDiagnostics } from './diagnostics.server.js';
import { getRunEvents, getRunLedger, getStoredRun } from './runStore.server.js';
import { deriveTaskGraph } from './taskGraph.server.js';
import { createSupabaseApprovalStore } from './supabaseStore.server.js';

export async function createRunAuditBundle(runId, options = {}) {
	const run = await getStoredRun(runId);
	if (!run) return undefined;
	const [ledger, events, diagnostics, approvals] = await Promise.all([
		getRunLedger(runId),
		getRunEvents(runId),
		collectDiagnostics(options.diagnostics ?? {}),
		createSupabaseApprovalStore().listForRun(runId, { projectId: run.config?.projectId })
	]);
	if (!ledger || !events) return undefined;
	const graph = deriveTaskGraph(run);
	const generatedAt = (options.now ?? new Date()).toISOString();
	const components = {
		run,
		executionContext: run.config?.executionContext ?? null,
		approvals,
		ledger,
		events,
		graph,
		diagnostics: redactDiagnostics(diagnostics)
	};
	const componentHashes = Object.fromEntries(Object.entries(components).map(([key, value]) => [key, sha256(canonicalJson(value))]));
	const manifest = {
		version: 1,
		format: 'kcevagent.run-audit-bundle',
		generatedAt,
		runId: run.id,
		status: run.status,
		provider: run.config?.provider ?? 'unknown',
		model: run.config?.model ?? 'unknown',
		correlationId: run.config?.executionContext?.correlationId ?? null,
		policySha256: run.config?.executionContext?.policySha256 ?? null,
		componentHashes
	};
	const withoutDigest = { manifest, ...components };
	return {
		...withoutDigest,
		manifest: {
			...manifest,
			bundleSha256: sha256(canonicalJson(withoutDigest))
		}
	};
}

function redactDiagnostics(diagnostics) {
	return JSON.parse(JSON.stringify(diagnostics, (key, value) => /token|secret|authorization|api.?key|password/i.test(key) ? '[REDACTED]' : value));
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
