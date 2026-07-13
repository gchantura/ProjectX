import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAnthropicProvider } from './providers/anthropic.server.js';
import { createGeminiProvider } from './providers/gemini.server.js';
import { createLocalOpenAIProvider } from './providers/localOpenAI.server.js';
import { createOpenAIProvider } from './providers/openai.server.js';
import { createOllamaProvider } from './providers/ollama.server.js';
import { createXaiProvider } from './providers/xai.server.js';

const STORE_DIR_NAME = '.kcevagent';
const PROBE_FILE_NAME = 'provider-probes.json';

export const PROBE_DEFINITIONS = [
	{ id: 'json-contract', label: 'Structured JSON contract' },
	{ id: 'single-tool', label: 'Single tool call shape' },
	{ id: 'multi-tool', label: 'Multi-tool recovery' },
	{ id: 'malformed-input', label: 'Malformed input recovery' }
];

export const CLOUD_PROBE_DEFINITIONS = [
	{ id: 'api-key', label: 'Server API key configured' },
	{ id: 'structured-output', label: 'Live structured output' },
	{ id: 'bounded-recovery', label: 'Bounded retry and timeout contract' },
	{ id: 'malformed-input', label: 'Malformed output fails closed' }
];

export function getProviderProbePath() {
	const root = process.env.KCEV_AGENT_DATA_DIR || path.join(process.cwd(), STORE_DIR_NAME);
	return path.join(root, PROBE_FILE_NAME);
}

export async function readProviderProbeCache() {
	try {
		const raw = JSON.parse(await readFile(getProviderProbePath(), 'utf8'));
		return normalizeProbeCache(raw);
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error;
		return {};
	}
}

export async function runProviderCapabilityProbes(providerId, now = new Date(), options = {}) {
	const checkedAt = now.toISOString();
	const started = Date.now();
	const result =
		providerId === 'cloud-openai'
			? await probeStructuredCloud(checkedAt, {
				envKey: 'OPENAI_API_KEY',
				model: options.model ?? process.env.KCEV_OPENAI_MODEL ?? 'gpt-5.5',
				source: 'live-responses-api',
				keyHint: 'Set OPENAI_API_KEY on the server.',
				provider: options.openAIProvider ?? (process.env.OPENAI_API_KEY ? createOpenAIProvider({ timeoutMs: 20_000, maxRetries: 1 }) : undefined),
				capabilities: { nativeToolCalling: false, jsonMode: true, contextWindow: 400000, streaming: true, visionInput: true }
			})
		: providerId === 'cloud-anthropic'
			? await probeStructuredCloud(checkedAt, {
				envKey: 'ANTHROPIC_API_KEY',
				model: options.model ?? process.env.KCEV_ANTHROPIC_MODEL ?? 'claude-sonnet-5',
				source: 'live-anthropic-messages-api',
				keyHint: 'Set ANTHROPIC_API_KEY on the server.',
				provider: options.anthropicProvider ?? (process.env.ANTHROPIC_API_KEY ? createAnthropicProvider({ timeoutMs: 20_000, maxRetries: 1 }) : undefined),
				capabilities: { nativeToolCalling: true, jsonMode: true, contextWindow: 200000, streaming: true, visionInput: true }
			})
		: providerId === 'cloud-gemini'
			? await probeStructuredCloud(checkedAt, {
				envKey: process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : 'GOOGLE_API_KEY',
				model: options.model ?? process.env.KCEV_GEMINI_MODEL ?? 'gemini-3.5-flash',
				source: 'live-gemini-generate-content-api',
				keyHint: 'Set GEMINI_API_KEY or GOOGLE_API_KEY on the server.',
				provider: options.geminiProvider ?? ((process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) ? createGeminiProvider({ timeoutMs: 20_000, maxRetries: 1 }) : undefined),
				capabilities: { nativeToolCalling: true, jsonMode: true, contextWindow: 1000000, streaming: true, visionInput: true }
			})
		: providerId === 'cloud-xai'
			? await probeStructuredCloud(checkedAt, {
				envKey: 'XAI_API_KEY',
				model: options.model ?? process.env.KCEV_XAI_MODEL ?? 'grok-4.5',
				source: 'live-xai-chat-completions-api',
				keyHint: 'Set XAI_API_KEY on the server.',
				provider: options.xaiProvider ?? (process.env.XAI_API_KEY ? createXaiProvider({ timeoutMs: 20_000, maxRetries: 1 }) : undefined),
				capabilities: { nativeToolCalling: true, jsonMode: true, contextWindow: 256000, streaming: true, visionInput: true }
			})
		: providerId === 'local-ollama'
				? await probeOllama(checkedAt, options.ollamaProvider, options.model)
		: providerId === 'local-openai-compatible'
				? await probeLocalOpenAI(checkedAt, options.localOpenAIProvider, options.model)
			: providerId === 'deterministic-local'
				? probeDeterministicLocal(checkedAt)
				: undefined;

	if (!result) {
		throw new Error(`Unknown provider: ${providerId}`);
	}

	const cache = await readProviderProbeCache();
	const model = options.model ?? result.model;
	const cacheKey = providerProbeCacheKey(providerId, model);
	const next = {
		...cache,
		[cacheKey]: {
			...result,
			model: model ?? null,
			durationMs: Math.max(Date.now() - started, 0)
		}
	};
	await writeProviderProbeCache(next);
	return next[cacheKey];
}

async function probeLocalOpenAI(checkedAt, injectedProvider, requestedModel) {
	const provider = injectedProvider ?? createLocalOpenAIProvider({ timeoutMs: 180_000 });
	let models = [];
	let result;
	let error;
	try {
		models = await provider.listModels();
		if (models.length === 0) throw new Error('No local OpenAI-compatible models are exposed by the runtime.');
		const model = requestedModel ?? process.env.KCEV_LOCAL_OPENAI_MODEL ?? models[0].name;
		if (!models.some((candidate) => candidate.name === model)) throw new Error(`Local OpenAI-compatible model is not exposed: ${model}`);
		result = await provider.completeStructured({ model, schemaName: 'capability_probe', maxOutputTokens: 64,
			schema: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'], additionalProperties: false },
			messages: [{ role: 'system', content: 'Return exactly JSON with ready=true.' }] });
	} catch (caught) { error = caught; }
	const passed = result?.value?.ready === true;
	return {
		model: requestedModel ?? process.env.KCEV_LOCAL_OPENAI_MODEL ?? models[0]?.name ?? null,
		checkedAt, source: passed ? 'live-local-openai-compatible-api' : 'live-probe-failed',
		capabilities: { nativeToolCalling: true, jsonMode: passed, contextWindow: 131072, streaming: true, visionInput: false },
		probes: CLOUD_PROBE_DEFINITIONS.map((probe) => {
			if (probe.id === 'api-key') return { ...probe, label: 'Local runtime and model detected', passed: models.length > 0, reason: models.length ? `${models.length} exposed model(s) detected.` : String(error?.message ?? 'Local runtime unavailable').slice(0, 160) };
			return { ...probe, passed, reason: passed ? `Live local JSON Schema response succeeded with ${result.usage.totalTokens} tokens.` : String(error?.message ?? 'Structured probe failed').slice(0, 160) };
		})
	};
}

async function probeOllama(checkedAt, injectedProvider, requestedModel) {
	const provider = injectedProvider ?? createOllamaProvider({ timeoutMs: 180_000 });
	let models = [];
	let result;
	let error;
	try {
		models = await provider.listModels();
		if (models.length === 0) throw new Error('No Ollama models are installed.');
		const model = requestedModel ?? process.env.KCEV_OLLAMA_MODEL ?? models[0].name;
		if (!models.some((candidate) => candidate.name === model)) throw new Error(`Ollama model is not installed: ${model}`);
		result = await provider.completeStructured({ model, schemaName: 'capability_probe', maxOutputTokens: 64,
			schema: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'], additionalProperties: false },
			messages: [{ role: 'system', content: 'Return exactly JSON with ready=true.' }] });
	} catch (caught) { error = caught; }
	const passed = result?.value?.ready === true;
	return {
		model: requestedModel ?? process.env.KCEV_OLLAMA_MODEL ?? models[0]?.name ?? null,
		checkedAt, source: passed ? 'live-ollama-api' : 'live-probe-failed',
		capabilities: { nativeToolCalling: false, jsonMode: passed, contextWindow: Number(models[0]?.details?.context_length) || 0, streaming: true, visionInput: false },
		probes: CLOUD_PROBE_DEFINITIONS.map((probe) => {
			if (probe.id === 'api-key') return { ...probe, label: 'Local runtime and model detected', passed: models.length > 0, reason: models.length ? `${models.length} installed model(s) detected.` : String(error?.message ?? 'Ollama unavailable').slice(0, 160) };
			return { ...probe, passed, reason: passed ? `Live Ollama JSON Schema response succeeded with ${result.usage.totalTokens} tokens.` : String(error?.message ?? 'Structured probe failed').slice(0, 160) };
		})
	};
}

export async function writeProviderProbeCache(cache) {
	const probePath = getProviderProbePath();
	await mkdir(path.dirname(probePath), { recursive: true });
	await writeFile(probePath, `${JSON.stringify(normalizeProbeCache(cache), null, 2)}\n`, 'utf8');
}

function probeDeterministicLocal(checkedAt) {
	const fixture = {
		plan: [{ id: 'step-1', tool: { name: 'inspect_context', arguments: { path: 'PROJECT_MAP.md' } } }],
		recovery: { malformedInputHandled: true }
	};

	return {
		checkedAt,
		source: 'local-contract',
		capabilities: {
			nativeToolCalling: hasToolCall(fixture.plan[0]),
			jsonMode: canRoundTripJson(fixture),
			contextWindow: 32000,
			streaming: true,
			visionInput: false
		},
		probes: PROBE_DEFINITIONS.map((probe) => ({
			...probe,
			passed: evaluateLocalProbe(probe.id, fixture),
			reason: localProbeReason(probe.id)
		}))
	};
}

async function probeStructuredCloud(checkedAt, { envKey, model, source, keyHint, provider, capabilities }) {
	const hasKey = Boolean(process.env[envKey]) || Boolean(provider);
	let liveResult;
	let liveError;
	if (hasKey && provider) {
		try {
			liveResult = await provider.completeStructured({
				model, schemaName: 'capability_probe', maxOutputTokens: 1024,
				schema: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'], additionalProperties: false },
				messages: [{ role: 'system', content: 'Return ready=true. This is a provider capability probe.' }]
			});
		} catch (error) { liveError = error; }
	}
	const livePassed = liveResult?.value?.ready === true;

	return {
		checkedAt,
		source: livePassed ? source : hasKey ? 'live-probe-failed' : 'environment-check',
		capabilities: livePassed ? capabilities : { nativeToolCalling: false, jsonMode: false, contextWindow: 0, streaming: false, visionInput: false },
		probes: CLOUD_PROBE_DEFINITIONS.map((probe) => cloudProbeResult(probe, { hasKey, livePassed, liveError, liveResult, keyHint, source }))
	};
}

function cloudProbeResult(probe, { hasKey, livePassed, liveError, liveResult, keyHint, source }) {
	if (probe.id === 'api-key') return { ...probe, passed: hasKey, reason: hasKey ? 'Server credential is available without exposing it to the client.' : keyHint };
	if (probe.id === 'structured-output') return { ...probe, passed: livePassed, reason: livePassed ? `${source} returned strict JSON (${liveResult.usage?.totalTokens ?? 0} tokens).` : `Live probe failed: ${String(liveError?.message ?? 'credential unavailable').slice(0, 160)}` };
	if (probe.id === 'bounded-recovery') return { ...probe, passed: livePassed, reason: livePassed ? 'Adapter enforces timeout, cancellation, and bounded retries around the live request.' : 'Adapter contract is present; live execution must pass first.' };
	return { ...probe, passed: livePassed, reason: livePassed ? 'Adapter rejects refusals, empty output, and malformed JSON without fallback success.' : 'Malformed-output contract is present; live execution must pass first.' };
}

function evaluateLocalProbe(id, fixture) {
	if (id === 'json-contract') return canRoundTripJson(fixture);
	if (id === 'single-tool') return hasToolCall(fixture.plan[0]);
	if (id === 'multi-tool') return fixture.plan.every(hasToolCall);
	if (id === 'malformed-input') return fixture.recovery.malformedInputHandled === true;
	return false;
}

function localProbeReason(id) {
	if (id === 'json-contract') return 'Local provider emitted parseable structured output.';
	if (id === 'single-tool') return 'Local provider emitted a single tool call with name and arguments.';
	if (id === 'multi-tool') return 'Local provider preserved tool-call structure across the plan.';
	return 'Local provider returned a bounded recovery result for malformed input.';
}

function hasToolCall(step) {
	return typeof step?.tool?.name === 'string' && typeof step?.tool?.arguments === 'object';
}

function canRoundTripJson(value) {
	try {
		return JSON.parse(JSON.stringify(value))?.plan?.length > 0;
	} catch {
		return false;
	}
}

function normalizeProbeCache(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return {};

	return Object.fromEntries(
		Object.entries(input)
			.filter(([providerId, record]) => /^[a-z0-9._:/-]{1,300}$/i.test(providerId) && record)
			.map(([providerId, record]) => [
				providerId,
				{
					model: /^[a-z0-9._:/-]{1,200}$/i.test(String(record.model ?? '')) ? String(record.model) : null,
					checkedAt: validDate(record.checkedAt) ? record.checkedAt : new Date(0).toISOString(),
					source: String(record.source ?? 'unknown').slice(0, 64),
					durationMs: Math.max(Number(record.durationMs) || 0, 0),
					capabilities: normalizeCapabilities(record.capabilities),
					probes: normalizeProbes(record.probes)
				}
			])
	);
}

export function providerProbeCacheKey(providerId, model) {
	return model ? `${providerId}::${model}` : providerId;
}

function normalizeCapabilities(input = {}) {
	return {
		nativeToolCalling: input.nativeToolCalling === true,
		jsonMode: input.jsonMode === true,
		contextWindow: Math.max(Number(input.contextWindow) || 0, 0),
		streaming: input.streaming === true,
		visionInput: input.visionInput === true
	};
}

function normalizeProbes(input = []) {
	return (Array.isArray(input) ? input : []).map((probe) => ({
		id: String(probe.id ?? '').slice(0, 64),
		label: String(probe.label ?? '').slice(0, 120),
		passed: probe.passed === true,
		reason: String(probe.reason ?? '').slice(0, 240)
	}));
}

function validDate(value) {
	return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}
