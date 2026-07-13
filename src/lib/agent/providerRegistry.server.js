import {
	CLOUD_PROBE_DEFINITIONS,
	PROBE_DEFINITIONS,
	providerProbeCacheKey,
	readProviderProbeCache,
	runProviderCapabilityProbes
} from './providerProbeStore.server.js';
import { createOllamaProvider } from './providers/ollama.server.js';
import { createLocalOpenAIProvider } from './providers/localOpenAI.server.js';

const PROVIDERS = [
	{
		id: 'deterministic-local',
		name: 'Deterministic Local',
		models: ['kcev-sim-1'],
		mode: 'local',
		description: 'Offline deterministic provider used for sandboxed planning and repeatable tests.',
		capabilities: {
			nativeToolCalling: true,
			jsonMode: true,
			contextWindow: 32000,
			streaming: true,
			visionInput: false
		},
		probes: PROBE_DEFINITIONS
	},
	{
		id: 'cloud-openai',
		name: 'OpenAI Cloud',
		models: ['gpt-5.5'],
		mode: 'cloud',
		description: 'Production OpenAI Responses API adapter with strict planner and verifier contracts.',
		capabilities: {
			nativeToolCalling: false,
			jsonMode: false,
			contextWindow: 0,
			streaming: false,
			visionInput: false
		},
		probes: CLOUD_PROBE_DEFINITIONS
	},
	{
		id: 'cloud-anthropic',
		name: 'Claude Cloud',
		models: [process.env.KCEV_ANTHROPIC_MODEL ?? 'claude-sonnet-5'],
		mode: 'cloud',
		description: 'Native Anthropic Messages adapter using output_config JSON Schema for planner, executor, and verifier contracts.',
		capabilities: {
			nativeToolCalling: false,
			jsonMode: false,
			contextWindow: 0,
			streaming: false,
			visionInput: false
		},
		probes: CLOUD_PROBE_DEFINITIONS
	},
	{
		id: 'cloud-gemini',
		name: 'Gemini Cloud',
		models: [process.env.KCEV_GEMINI_MODEL ?? 'gemini-3.5-flash'],
		mode: 'cloud',
		description: 'Google Gemini generateContent adapter using server-side API keys and response schema enforcement.',
		capabilities: {
			nativeToolCalling: false,
			jsonMode: false,
			contextWindow: 0,
			streaming: false,
			visionInput: false
		},
		probes: CLOUD_PROBE_DEFINITIONS
	},
	{
		id: 'cloud-xai',
		name: 'Grok / xAI Cloud',
		models: [process.env.KCEV_XAI_MODEL ?? 'grok-4.5'],
		mode: 'cloud',
		description: 'xAI Grok adapter using OpenAI-compatible chat completions with strict JSON Schema response format.',
		capabilities: {
			nativeToolCalling: false,
			jsonMode: false,
			contextWindow: 0,
			streaming: false,
			visionInput: false
		},
		probes: CLOUD_PROBE_DEFINITIONS
	},
	{
		id: 'local-ollama',
		name: 'Ollama Local Models',
		models: [process.env.KCEV_OLLAMA_MODEL ?? 'ornith:9b'],
		mode: 'local',
		description: 'Private on-device execution through Ollama with native JSON Schema enforcement.',
		capabilities: { nativeToolCalling: false, jsonMode: false, contextWindow: 0, streaming: true, visionInput: false },
		probes: CLOUD_PROBE_DEFINITIONS
	},
	{
		id: 'local-openai-compatible',
		name: 'Local OpenAI-Compatible',
		models: [process.env.KCEV_LOCAL_OPENAI_MODEL ?? 'local-model'],
		mode: 'local',
		description: 'Private local execution through LM Studio, llama.cpp server, vLLM, or any /v1 chat-completions runtime with JSON Schema responses.',
		capabilities: { nativeToolCalling: false, jsonMode: false, contextWindow: 0, streaming: true, visionInput: false },
		probes: CLOUD_PROBE_DEFINITIONS
	}
];

async function fetchDynamicModelsForProvider(provider) {
	if (provider.id === 'local-ollama') {
		try {
			const ollama = createOllamaProvider();
			const list = await ollama.listModels();
			if (list.length > 0) {
				return list.map((m) => m.name);
			}
		} catch (e) {
			// Fallback to configured default
		}
	} else if (provider.id === 'local-openai-compatible') {
		try {
			const localOpenAI = createLocalOpenAIProvider();
			const list = await localOpenAI.listModels();
			if (list.length > 0) {
				return list.map((m) => m.name);
			}
		} catch (e) {
			// Fallback to configured default
		}
	}
	return provider.models;
}

export async function listProviderReadiness() {
	const cache = await readProviderProbeCache();
	return Promise.all(PROVIDERS.map(async (provider) => {
		const dynamicModels = await fetchDynamicModelsForProvider(provider);
		const defaultModel = dynamicModels[0] ?? provider.models[0];
		return evaluateProvider({ ...provider, models: dynamicModels }, cache[providerProbeCacheKey(provider.id, defaultModel)] ?? cache[provider.id], defaultModel);
	}));
}

export async function getProviderReadiness(id, model) {
	const provider = PROVIDERS.find((candidate) => candidate.id === id);
	if (!provider) return undefined;
	const dynamicModels = await fetchDynamicModelsForProvider(provider);
	const cache = await readProviderProbeCache();
	const selectedModel = model ?? dynamicModels[0] ?? provider.models[0];
	return evaluateProvider({ ...provider, models: dynamicModels }, cache[providerProbeCacheKey(provider.id, selectedModel)] ?? (!model ? cache[provider.id] : undefined), selectedModel);
}

export async function runProviderReadinessProbe(id, options = {}) {
	const record = await runProviderCapabilityProbes(id, new Date(), options);
	const provider = PROVIDERS.find((candidate) => candidate.id === id);
	if (!provider) return undefined;
	const dynamicModels = await fetchDynamicModelsForProvider(provider);
	const selectedModel = options.model ?? dynamicModels[0] ?? provider.models[0];
	return provider ? evaluateProvider({ ...provider, models: dynamicModels }, record, selectedModel) : undefined;
}

export function evaluateProvider(provider, probeRecord, selectedModel = provider.models[0]) {
	const capabilities = probeRecord?.capabilities ?? provider.capabilities;
	const checkedAt = probeRecord?.checkedAt ?? null;
	const probes = mergeProbeDefinitions(provider.probes, probeRecord?.probes).map((probe) => ({
		...probe,
		status: probe.passed ? 'passed' : 'blocked'
	}));
	const passed = probes.filter((probe) => probe.passed).length;
	const reliabilityScore = Math.round((passed / probes.length) * 100);
	const probedModel = probeRecord?.model ?? provider.models[0];
	const ready = probedModel === selectedModel && reliabilityScore >= 75 && (provider.id === 'deterministic-local' ? capabilities.nativeToolCalling : capabilities.jsonMode);

	return {
		id: provider.id,
		name: provider.name,
		mode: provider.mode,
		description: provider.description,
		models: provider.models,
		defaultModel: provider.models[0],
		selectedModel,
		probedModel,
		ready,
		status: ready ? 'ready' : 'blocked',
		reliabilityScore,
		capabilities,
		probes,
		checkedAt,
		probeSource: probeRecord?.source ?? 'not-run',
		probeDurationMs: probeRecord?.durationMs ?? 0,
		nextAction: ready
			? 'Provider can execute planned coding runs.'
			: checkedAt
				? 'Resolve blocked probes before enabling this provider for production execution.'
				: 'Run capability probes before enabling this provider for production execution.'
	};
}

function mergeProbeDefinitions(definitions, records = []) {
	const recordById = new Map(records.map((record) => [record.id, record]));
	return definitions.map((definition) => ({
		...definition,
		passed: recordById.get(definition.id)?.passed === true,
		reason: recordById.get(definition.id)?.reason ?? 'Probe has not been run.'
	}));
}
