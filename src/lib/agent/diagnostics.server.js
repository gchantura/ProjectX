import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRunEvents, listStoredRuns } from './runStore.server.js';
import { listProviderReadiness } from './providerRegistry.server.js';
import { createOllamaProvider } from './providers/ollama.server.js';
import { createSupabaseApprovalStore, createSupabaseLeaseStore, getSupabaseConfig, isSupabaseTestMode } from './supabaseStore.server.js';
import { createIdentityStore } from '../server/identityStore.server.js';
import { discoverOidc, oidcConfig } from '../server/oidc.server.js';
import { createOidcConnectionStore, resolveTenantOidcConfig } from '../server/oidcConnectionStore.server.js';
import { createAuditStore } from '../server/auditStore.server.js';
import { createDistributedRateLimitStore } from '../server/rateLimitStore.server.js';

export async function collectDiagnostics(options = {}) {
	const now = options.now ?? new Date();
	const [storage, identityDirectory, audit, rateLimiting, federation, secretEncryption, providers, localModels] = await Promise.all([
		checkStorage(),
		checkIdentityDirectory(),
		checkAuditChain(),
		checkRateLimiting(),
		checkFederation(options.oidcFetch),
		checkSecretEncryption(),
		checkProviders(),
		checkLocalModels(options.ollamaProvider),
	]);
	const memory = checkMemoryBackend();
	const security = checkSecurity(identityDirectory);
	const events = await checkEventTimeline();
	const checks = [storage, identityDirectory, audit, rateLimiting, federation, secretEncryption, memory, security, events, localModels, ...providers.items.map((provider) => provider.check)];
	const summary = summarizeChecks(checks);
	return {
		status: summary.ready ? 'ready' : 'degraded',
		checkedAt: now.toISOString(),
		summary,
		storage,
		identityDirectory,
		audit,
		rateLimiting,
		federation,
		secretEncryption,
		memory,
		security,
		events,
		providers,
		localModels
	};
}

async function checkSecretEncryption() {
	if (isSupabaseTestMode()) return check('secret-encryption', 'passed', 'Versioned tenant secret encryption is available in test mode.', { activeKeyId: 'test', records: 0, pendingRotation: 0, retirementReady: true });
	const store = createOidcConnectionStore();
	if (!store) return check('secret-encryption', process.env.NODE_ENV === 'production' ? 'failed' : 'warning', 'A versioned tenant secrets keyring is not configured.', { configured: false, retirementReady: false });
	try {
		const status = await store.keyRotationStatus();
		return check('secret-encryption', status.pending === 0 ? 'passed' : 'warning', status.pending === 0 ? 'Every tenant integration secret uses the active encryption key.' : `${status.pending} tenant integration secret(s) still require re-encryption before old keys can be retired.`, { configured: true, activeKeyId: status.activeKeyId, records: status.total, pendingRotation: status.pending, retirementReady: status.pending === 0, keyVersionsInUse: Object.keys(status.byKey).length });
	} catch (error) { return check('secret-encryption', 'failed', String(error?.message ?? 'Secret encryption posture is unavailable.').slice(0, 220), { configured: true, retirementReady: false }); }
}

async function checkRateLimiting() {
	if (isSupabaseTestMode()) return check('rate-limiting', 'passed', 'Shared request admission is available in test mode.', { backend: 'supabase-postgres', distributed: true });
	const store = createDistributedRateLimitStore();
	if (!store) return check('rate-limiting', process.env.NODE_ENV === 'production' ? 'failed' : 'warning', 'Shared request admission is not configured; this process uses a local development limiter.', { backend: 'process-memory', distributed: false });
	try { return check('rate-limiting', 'passed', 'Atomic request admission is shared across application replicas.', await store.status()); }
	catch (error) { return check('rate-limiting', 'failed', String(error?.message ?? 'Distributed rate limiting is unavailable.').slice(0, 220), { backend: 'supabase-postgres', distributed: true }); }
}

async function checkAuditChain() {
	if (isSupabaseTestMode()) return check('security-audit', 'passed', 'Tenant audit chain is available in test mode.', { valid: true, eventCount: 0 });
	const store = createAuditStore();
	if (!store) return check('security-audit', 'failed', 'Supabase security audit ledger is not configured.', { valid: false, eventCount: 0 });
	try {
		const result = await store.verify();
		return check('security-audit', result.valid ? 'passed' : 'failed', result.valid ? 'Append-only security audit chain integrity is verified.' : `Audit chain integrity failed at sequence ${result.firstInvalidSequence}.`, result);
	} catch (error) { return check('security-audit', 'failed', String(error?.message ?? 'Security audit verification is unavailable.').slice(0, 220), { valid: false, eventCount: 0 }); }
}

async function checkFederation(fetchImpl) {
	try {
		const tenantId = getSupabaseConfig()?.tenantId;
		const config = tenantId ? await resolveTenantOidcConfig(tenantId) : oidcConfig();
		if (!config) return check('federation', 'passed', 'OIDC federation is not enabled for this organization.', { enabled: false });
		const metadata = await discoverOidc(config, fetchImpl ?? globalThis.fetch);
		return check('federation', 'passed', 'Tenant OIDC discovery, authorization code, PKCE, and signing metadata are valid.', { enabled: true, source: config.source, issuer: config.issuer, displayName: config.displayName, authorizationCode: metadata.response_types_supported?.includes('code') !== false, pkceS256: metadata.code_challenge_methods_supported?.includes('S256') !== false });
	} catch (error) { return check('federation', 'failed', String(error?.message ?? 'OIDC federation is unavailable.').slice(0, 220), { enabled: true }); }
}

async function checkIdentityDirectory() {
	if (isSupabaseTestMode()) return check('identity-directory', 'passed', 'Request-bound identity directory is available in test mode.', { backend: 'supabase-postgres', activeIdentities: 0, durableAudit: true, requestBoundTenancy: true, credentialGlobalUniqueness: true, organizationProvisioning: true, tenantLifecycleEnforcement: true, tenantOidcConnections: true, managedSecretRotation: true, organizationMemberships: true, identityLifecycleAutomation: true });
	const store = createIdentityStore();
	if (!store) return check('identity-directory', 'failed', 'Supabase identity directory is not configured.', { backend: 'supabase-postgres', durableAudit: false });
	try {
		const [identities, boundary] = await Promise.all([store.list(), store.boundaryStatus()]);
		const isolated = boundary?.requestBound === true && boundary?.credentialGlobalUniqueness === true && boundary?.organizationProvisioning === true && boundary?.tenantLifecycleEnforcement === true && boundary?.tenantOidcConnections === true && boundary?.managedSecretRotation === true && boundary?.organizationMemberships === true && boundary?.identityLifecycleAutomation === true;
		return check('identity-directory', isolated ? 'passed' : 'failed', isolated ? 'Tenant binding, credential uniqueness, lifecycle enforcement, tenant-owned SSO, managed secret rotation, organization memberships, invitations, and SCIM are verified.' : 'The organization and identity-lifecycle migrations are incomplete.', { backend: 'supabase-postgres', organization: String(boundary?.tenantName ?? 'Unknown').slice(0, 160), activeIdentities: identities.filter((identity) => identity.status === 'active').length, durableAudit: true, requestBoundTenancy: boundary?.requestBound === true, credentialGlobalUniqueness: boundary?.credentialGlobalUniqueness === true, organizationProvisioning: boundary?.organizationProvisioning === true, tenantLifecycleEnforcement: boundary?.tenantLifecycleEnforcement === true, tenantOidcConnections: boundary?.tenantOidcConnections === true, managedSecretRotation: boundary?.managedSecretRotation === true, organizationMemberships: boundary?.organizationMemberships === true, identityLifecycleAutomation: boundary?.identityLifecycleAutomation === true });
	} catch (error) { return check('identity-directory', 'failed', String(error?.message ?? 'Identity directory is unavailable.').slice(0, 220), { backend: 'supabase-postgres', durableAudit: false }); }
}

async function checkStorage() {
	const supabaseConfigured = Boolean(getSupabaseConfig()) || isSupabaseTestMode();
	const details = {
		backend: 'supabase',
		authoritativeStore: 'supabase-postgres',
		supabaseConfigured
	};
	try {
		if (!supabaseConfigured) throw new Error('Supabase storage is not configured.');
		const [, leaseStatus, approvalStatus] = await Promise.all([listStoredRuns({ limit: 1 }), createSupabaseLeaseStore().status(), createSupabaseApprovalStore().status()]);
		details.activeRunLeases = leaseStatus.activeLeases;
		details.durableRunLeases = true;
		details.pendingRunApprovals = approvalStatus.pendingApprovals;
		details.durableRunApprovals = true;
		return check('storage', 'passed', 'Supabase Postgres, durable run leases, and approval records are reachable.', details);
	} catch (error) {
		return check('storage', 'failed', String(error?.message ?? 'Run storage is unavailable.').slice(0, 220), details);
	}
}

function checkMemoryBackend() {
	const supabaseConfigured = Boolean(getSupabaseConfig()) || isSupabaseTestMode();
	return check('memory', supabaseConfigured ? 'passed' : 'failed', supabaseConfigured
		? 'Supabase Postgres is configured as the only memory store.'
		: 'Supabase memory is not configured.', { backend: 'supabase', authoritativeStore: 'supabase-postgres', supabaseConfigured });
}

function checkSecurity(identityDirectory) {
	const authRequired = process.env.KCEV_AUTH_REQUIRED === 'true';
	const tokenConfigured = Boolean(process.env.KCEV_OPERATOR_TOKEN && process.env.KCEV_OPERATOR_TOKEN.length >= 32);
	const namedOperatorsConfigured = configuredOperatorCount(process.env.KCEV_OPERATORS_JSON);
	const sessionSigningConfigured = Boolean(process.env.KCEV_SESSION_SECRET && process.env.KCEV_SESSION_SECRET.length >= 32);
	const contextSigningConfigured = Boolean(process.env.KCEV_EXECUTION_CONTEXT_SECRET && process.env.KCEV_EXECUTION_CONTEXT_SECRET.length >= 32);
	const trustedOrigins = String(process.env.KCEV_TRUSTED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean).length;
	const production = process.env.NODE_ENV === 'production';
	const durableIdentitiesConfigured = identityDirectory?.status === 'passed' && identityDirectory.details.activeIdentities > 0;
	const identityConfigured = tokenConfigured || namedOperatorsConfigured > 0 || durableIdentitiesConfigured;
	const ok = !production ? true : authRequired && identityConfigured && sessionSigningConfigured && contextSigningConfigured;
	return check('security', ok ? 'passed' : 'failed', ok ? 'Authentication, role identity, and independent signing posture are acceptable for this environment.' : 'Production requires authentication, at least one operator identity, and independent session and execution-context signing secrets.', { authRequired, tokenConfigured, namedOperatorsConfigured, durableIdentitiesConfigured, sessionSigningConfigured, contextSigningConfigured, trustedOrigins, production });
}

function configuredOperatorCount(value) {
	try { const operators = JSON.parse(value ?? '[]'); return Array.isArray(operators) ? operators.filter((item) => ['viewer', 'operator', 'admin'].includes(item?.role) && /^[a-f0-9]{64}$/i.test(item?.tokenSha256 ?? '')).length : 0; }
	catch { return 0; }
}

async function checkProviders() {
	const readiness = await listProviderReadiness();
	const items = readiness.map((provider) => ({
		id: provider.id,
		name: provider.name,
		ready: provider.ready,
		status: provider.status,
		reliabilityScore: provider.reliabilityScore,
		defaultModel: provider.defaultModel,
		checkedAt: provider.checkedAt,
		check: check(`provider:${provider.id}`, provider.ready ? 'passed' : 'warning', provider.ready ? 'Provider passed readiness gates.' : provider.nextAction, { reliabilityScore: provider.reliabilityScore, probeSource: provider.probeSource })
	}));
	const readyCount = items.filter((provider) => provider.ready).length;
	return { readyCount, total: items.length, items };
}

async function checkLocalModels(injectedProvider) {
	const installed = await discoverInstalledLocalModels();
	try {
		const provider = injectedProvider ?? createOllamaProvider({ timeoutMs: 10_000 });
		const models = await provider.listModels();
		return check('local-models', models.length > 0 ? 'passed' : 'warning', models.length > 0 ? `${models.length} local model(s) available through the running Ollama runtime.` : 'Ollama is reachable but no models were exposed by the runtime.', {
			count: models.length,
			runtimeReachable: true,
			installedCount: installed.count,
			installedModels: installed.models,
			models: models.slice(0, 20).map((model) => ({ name: model.name, family: model.details?.family ?? model.details?.families?.[0] ?? 'unknown', parameterSize: model.details?.parameter_size ?? 'unknown', quantization: model.details?.quantization_level ?? 'unknown' }))
		});
	} catch (error) {
		return check('local-models', installed.count > 0 ? 'warning' : 'warning', installed.count > 0 ? `${installed.count} local model manifest(s) are installed, but no local runtime is reachable for execution.` : String(error?.message ?? 'No local model runtime is reachable.').slice(0, 220), { count: 0, runtimeReachable: false, installedCount: installed.count, installedModels: installed.models, models: [] });
	}
}

export async function discoverInstalledLocalModels(options = {}) {
	const ollamaRoot = options.ollamaRoot ?? process.env.OLLAMA_MODELS ?? path.join(os.homedir(), '.ollama', 'models');
	const lmStudioRoots = options.lmStudioRoots ?? [
		path.join(os.homedir(), '.lmstudio', 'models'),
		path.join(os.homedir(), '.cache', 'lm-studio', 'models')
	];
	const [ollama, lmStudio] = await Promise.all([
		discoverOllamaManifests(ollamaRoot),
		discoverModelFiles(lmStudioRoots, 'lm-studio')
	]);
	const models = [...ollama, ...lmStudio].slice(0, 50);
	return { count: models.length, models };
}

async function discoverOllamaManifests(root) {
	const manifests = path.join(root, 'manifests');
	const files = await walkFiles(manifests, 5);
	const models = [];
	for (const file of files) {
		const relative = path.relative(manifests, file).split(path.sep);
		if (relative.length < 4) continue;
		const namespace = relative.at(-3);
		const name = relative.at(-2);
		const tag = relative.at(-1);
		const manifest = await readManifestSummary(file);
		models.push({
			name: namespace === 'library' ? `${name}:${tag}` : `${namespace}/${name}:${tag}`,
			runtime: 'ollama',
			source: 'disk-manifest',
			sizeBytes: manifest.sizeBytes
		});
	}
	return models.sort((left, right) => left.name.localeCompare(right.name));
}

async function discoverModelFiles(roots, runtime) {
	const models = [];
	for (const root of roots) {
		const files = await walkFiles(root, 4);
		for (const file of files.filter((candidate) => /\.(gguf|safetensors|bin)$/i.test(candidate))) {
			const info = await stat(file).catch(() => ({ size: 0 }));
			models.push({ name: path.basename(file), runtime, source: 'model-file', sizeBytes: info.size ?? 0 });
		}
	}
	return models.sort((left, right) => left.name.localeCompare(right.name));
}

async function readManifestSummary(file) {
	try {
		const manifest = JSON.parse(await readFile(file, 'utf8'));
		const sizeBytes = (manifest.layers ?? [])
			.filter((layer) => String(layer.mediaType ?? '').includes('image.model'))
			.reduce((sum, layer) => sum + (Number(layer.size) || 0), 0);
		return { sizeBytes };
	} catch {
		return { sizeBytes: 0 };
	}
}

async function walkFiles(root, maxDepth, depth = 0) {
	if (depth > maxDepth) return [];
	let entries;
	try { entries = await readdir(root, { withFileTypes: true }); }
	catch { return []; }
	const nested = await Promise.all(entries.map(async (entry) => {
		const fullPath = path.join(root, entry.name);
		if (entry.isFile()) return [fullPath];
		if (entry.isDirectory()) return walkFiles(fullPath, maxDepth, depth + 1);
		return [];
	}));
	return nested.flat();
}

async function checkEventTimeline() {
	try {
		const [latest] = await listStoredRuns({ limit: 1 });
		if (!latest) return check('event-log', 'warning', 'No persisted runs exist yet, so event replay has no sample.', { latestRunId: null, eventCount: 0 });
		const events = await getRunEvents(latest.id);
		return check('event-log', events?.length > 0 ? 'passed' : 'warning', events?.length > 0 ? 'Latest run has a persisted replayable event timeline.' : 'Latest run has no persisted event timeline.', { latestRunId: latest.id, eventCount: events?.length ?? 0 });
	} catch (error) {
		return check('event-log', 'failed', String(error?.message ?? 'Event log is unavailable.').slice(0, 220), { latestRunId: null, eventCount: 0 });
	}
}

function check(id, status, message, details = {}) {
	return { id, status, passed: status === 'passed', message, details };
}

function summarizeChecks(checks) {
	const failed = checks.filter((item) => item.status === 'failed').length;
	const warnings = checks.filter((item) => item.status === 'warning').length;
	const passed = checks.filter((item) => item.status === 'passed').length;
	return { ready: failed === 0, passed, warnings, failed, total: checks.length };
}
