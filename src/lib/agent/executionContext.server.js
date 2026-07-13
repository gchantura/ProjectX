import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { getSupabaseConfig } from './supabaseStore.server.js';

const CONTEXT_VERSION = 1;

export function createExecutionContext({ config, readiness, actor = 'local-operator', correlationId, now = new Date(), env = process.env } = {}) {
	const policy = policySnapshot(config);
	const unsigned = {
		version: CONTEXT_VERSION,
		organizationId: getSupabaseConfig(env)?.tenantId ?? 'organization-local',
		projectId: String(config?.projectId ?? ''),
		workspaceRoot: canonicalPath(config?.workspaceRoot),
		repositoryRoot: readiness?.repository?.root ? canonicalPath(readiness.repository.root) : null,
		commit: readiness?.repository?.commit ?? null,
		branch: readiness?.repository?.branch ?? null,
		actor: String(actor || 'local-operator').slice(0, 160),
		correlationId: validCorrelationId(correlationId) ? correlationId : randomUUID(),
		issuedAt: now.toISOString(),
		policy,
		policySha256: sha256(canonicalJson(policy))
	};
	return Object.freeze({ ...unsigned, signature: sign(unsigned, env) });
}

export function validateExecutionContext(context, { config, readiness, env = process.env } = {}) {
	if (!context || context.version !== CONTEXT_VERSION) return invalid('Execution context is missing or uses an unsupported version.');
	const { signature, ...unsigned } = context;
	if (!validSignature(signature, sign(unsigned, env))) return invalid('Execution context signature is invalid.');
	if (context.projectId !== String(config?.projectId ?? '')) return invalid('Execution context project does not match the admitted project.');
	if (canonicalPath(context.workspaceRoot) !== canonicalPath(config?.workspaceRoot)) return invalid('Execution context workspace does not match the registered project.');
	const currentPolicy = policySnapshot(config);
	if (context.policySha256 !== sha256(canonicalJson(currentPolicy))) return invalid('Project policy changed after this run was admitted.');
	if (readiness && context.commit !== (readiness.repository?.commit ?? null)) return invalid('Repository commit changed after this run was admitted.');
	return { valid: true, reason: 'Execution context signature, project, commit, and policy are valid.', context };
}

export function policySnapshot(config = {}) {
	return {
		autonomyMode: String(config.autonomyMode ?? 'execute'),
		allowedPaths: [...(config.allowedPaths ?? [])].map(String).sort(),
		networkAllowlist: [...(config.networkAllowlist ?? [])].map(String).sort(),
		requireApprovalForSourceWrites: config.requireApprovalForSourceWrites !== false,
		provider: String(config.provider ?? ''),
		model: String(config.model ?? ''),
		stepCeiling: Number(config.stepCeiling) || 0,
		maxTokensPerRun: Number(config.maxTokensPerRun) || 0,
		costCeilingUsd: Number(config.costCeilingUsd) || 0
	};
}

function sign(value, env) {
	return createHmac('sha256', signingSecret(env)).update(canonicalJson(value)).digest('hex');
}

function signingSecret(env) {
	const dedicatedSecret = String(env.KCEV_EXECUTION_CONTEXT_SECRET ?? '');
	if (dedicatedSecret.length >= 32) return dedicatedSecret;
	if (env.NODE_ENV === 'production') throw Object.assign(new Error('KCEV_EXECUTION_CONTEXT_SECRET must contain at least 32 characters in production.'), { status: 503, code: 'EXECUTION_CONTEXT_SECRET_MISSING' });
	const operatorSecret = String(env.KCEV_OPERATOR_TOKEN ?? '');
	if (operatorSecret.length >= 32) return operatorSecret;
	if (env.NODE_ENV === 'test') return 'kcevagent-test-execution-context-secret';
	throw Object.assign(new Error('KCEV_EXECUTION_CONTEXT_SECRET or KCEV_OPERATOR_TOKEN must contain at least 32 characters outside tests.'), { status: 503, code: 'EXECUTION_CONTEXT_SECRET_MISSING' });
}

function validSignature(actual, expected) {
	if (!/^[a-f0-9]{64}$/i.test(String(actual ?? ''))) return false;
	return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function canonicalPath(value) {
	return value == null ? null : path.resolve(String(value)).replaceAll('\\', '/').toLowerCase();
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

function validCorrelationId(value) {
	return /^[a-z0-9-]{8,128}$/i.test(String(value ?? ''));
}

function invalid(reason) {
	return { valid: false, reason };
}
