import { collectDiagnostics } from './diagnostics.server.js';
import { getProviderReadiness, listProviderReadiness } from './providerRegistry.server.js';

const HARD_BLOCK_CHECKS = new Set(['storage', 'memory', 'security']);

export async function collectGovernanceReport(input = {}, deps = {}) {
	const diagnostics = deps.diagnostics ?? await collectDiagnostics(deps.diagnosticsOptions ?? {});
	let providers = deps.providers ?? await listProviderReadiness();
	if (!deps.providers && input.selectedProviderId && input.selectedModel) {
		const selected = await getProviderReadiness(input.selectedProviderId, input.selectedModel);
		if (selected) providers = providers.map((provider) => provider.id === selected.id ? selected : provider);
	}
	return evaluateGovernanceReport({
		diagnostics,
		providers,
		selectedProviderId: input.selectedProviderId,
		selectedModel: input.selectedModel,
		mode: input.mode ?? 'interactive',
		now: input.now ?? new Date()
	});
}

export function evaluateGovernanceReport({ diagnostics, providers = [], selectedProviderId, selectedModel, mode = 'interactive', now = new Date() }) {
	const requestedProvider = selectedProviderId ? providers.find((provider) => provider.id === selectedProviderId) : undefined;
	const selectedProvider = selectedProviderId ? (requestedProvider ?? null) : (providers.find((provider) => provider.ready) ?? providers[0] ?? null);
	const checks = [
		...environmentChecks(diagnostics),
		...providerChecks(providers, selectedProvider, selectedProviderId),
		...operationalChecks(diagnostics, mode)
	];
	const blocking = checks.filter((check) => check.decision === 'block');
	const warnings = checks.filter((check) => check.decision === 'warn');
	const decision = blocking.length > 0 ? 'block' : warnings.length > 0 ? 'allow_with_warnings' : 'allow';
	return {
		status: decision,
		checkedAt: now.toISOString(),
		mode,
		selectedProvider: selectedProvider ? {
			id: selectedProvider.id,
			name: selectedProvider.name,
			ready: selectedProvider.ready,
			status: selectedProvider.status,
			reliabilityScore: selectedProvider.reliabilityScore,
			checkedAt: selectedProvider.checkedAt,
			probeSource: selectedProvider.probeSource
			,selectedModel: selectedProvider.selectedModel ?? selectedModel ?? selectedProvider.defaultModel,
			probedModel: selectedProvider.probedModel ?? null
		} : null,
		summary: {
			totalChecks: checks.length,
			passed: checks.filter((check) => check.decision === 'pass').length,
			warnings: warnings.length,
			blocking: blocking.length
		},
		checks,
		runGate: {
			canStartRun: decision !== 'block',
			reason: blocking[0]?.message ?? (warnings[0]?.message ?? 'Governance checks passed for a bounded run.'),
			requiredActions: [...blocking, ...warnings].map((check) => check.action)
		}
	};
}

function environmentChecks(diagnostics = {}) {
	const items = [diagnostics.storage, diagnostics.memory, diagnostics.security].filter(Boolean);
	return items.map((item) => ({
		id: `environment:${item.id}`,
		label: `${titleCase(item.id)} posture`,
		decision: item.status === 'failed' && HARD_BLOCK_CHECKS.has(item.id) ? 'block' : item.status === 'warning' ? 'warn' : 'pass',
		message: item.message,
		action: item.status === 'passed' ? 'No operator action required.' : remediationFor(item.id, item.message),
		evidence: { status: item.status, details: sanitizeDetails(item.details) }
	}));
}

function providerChecks(providers, selectedProvider, selectedProviderId) {
	const readyProviders = providers.filter((provider) => provider.ready);
	const checks = [{
		id: 'providers:ready-count',
		label: 'Provider fleet readiness',
		decision: readyProviders.length > 0 ? 'pass' : 'warn',
		message: readyProviders.length > 0 ? `${readyProviders.length} provider(s) passed readiness gates.` : 'No provider has passed readiness gates yet.',
		action: readyProviders.length > 0 ? 'No operator action required.' : 'Run provider probes and configure at least one execution provider.',
		evidence: { readyProviders: readyProviders.map((provider) => provider.id), totalProviders: providers.length }
	}];
	if (!selectedProvider) {
		checks.push({
			id: 'providers:selected',
			label: 'Selected provider',
			decision: 'block',
			message: selectedProviderId ? `Requested provider is not registered: ${selectedProviderId}.` : 'No execution provider is available.',
			action: selectedProviderId ? 'Choose a registered provider before starting a run.' : 'Configure at least one local or cloud provider before starting a run.',
			evidence: { selectedProviderId: selectedProviderId ?? null }
		});
		return checks;
	}
	checks.push({
		id: `providers:${selectedProvider.id}`,
		label: `Selected provider: ${selectedProvider.name}`,
		decision: selectedProvider.ready ? 'pass' : 'block',
		message: selectedProvider.ready ? 'Selected provider is ready for bounded execution.' : selectedProvider.nextAction,
		action: selectedProvider.ready ? 'No operator action required.' : 'Run provider probes or select a ready provider before starting a production run.',
		evidence: {
			id: selectedProvider.id,
			ready: selectedProvider.ready,
			status: selectedProvider.status,
			reliabilityScore: selectedProvider.reliabilityScore,
			checkedAt: selectedProvider.checkedAt,
			probeSource: selectedProvider.probeSource
		}
	});
	return checks;
}

function operationalChecks(diagnostics = {}, mode) {
	const checks = [];
	if (diagnostics.events) {
		checks.push({
			id: 'operations:event-replay',
			label: 'Event replayability',
			decision: diagnostics.events.status === 'failed' ? 'block' : diagnostics.events.status === 'warning' ? 'warn' : 'pass',
			message: diagnostics.events.message,
			action: diagnostics.events.status === 'passed' ? 'No operator action required.' : 'Complete one run and confirm persisted event replay before relying on audit playback.',
			evidence: { status: diagnostics.events.status, details: sanitizeDetails(diagnostics.events.details) }
		});
	}
	if (diagnostics.localModels) {
		checks.push({
			id: 'operations:local-models',
			label: 'Local LLM availability',
			decision: diagnostics.localModels.status === 'failed' ? 'block' : diagnostics.localModels.status === 'warning' ? 'warn' : 'pass',
			message: diagnostics.localModels.message,
			action: diagnostics.localModels.status === 'passed' ? 'No operator action required.' : 'Start Ollama and install or pull at least one local model for private fallback execution.',
			evidence: { status: diagnostics.localModels.status, details: sanitizeDetails(diagnostics.localModels.details) }
		});
	}
	checks.push({
		id: 'operations:mode',
		label: 'Execution mode',
		decision: mode === 'autonomous' ? 'warn' : 'pass',
		message: mode === 'autonomous' ? 'Autonomous mode requires close monitoring of budget, rollback, and source-write gates.' : 'Interactive operator mode is active.',
		action: mode === 'autonomous' ? 'Keep maintenance automation and metrics scraping active while autonomous runs are enabled.' : 'No operator action required.',
		evidence: { mode }
	});
	return checks;
}

function remediationFor(id, message) {
	if (id === 'storage') return 'Repair the run-store backend and confirm the ledger can read and write runs.';
	if (id === 'memory') return 'Configure and restore the Supabase memory connection before running agents.';
	if (id === 'security') return 'Enable authentication and set a strong operator token before production operation.';
	return message || 'Inspect diagnostics and resolve this check before production use.';
}

function sanitizeDetails(details = {}) {
	return JSON.parse(JSON.stringify(details, (key, value) => /token|secret|key|authorization|bearer/i.test(key) ? '[redacted]' : value));
}

function titleCase(value) {
	return String(value).replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
