import { createAnthropicProvider } from './providers/anthropic.server.js';
import { createGeminiProvider } from './providers/gemini.server.js';
import { createLocalOpenAIProvider } from './providers/localOpenAI.server.js';
import { createOpenAIProvider } from './providers/openai.server.js';
import { createOllamaProvider } from './providers/ollama.server.js';
import { createXaiProvider } from './providers/xai.server.js';

export function createConfiguredProvider(config = {}, options = {}) {
	if (config.provider === 'local-ollama') return createOllamaProvider(options.ollama);
	if (config.provider === 'local-openai-compatible') return createLocalOpenAIProvider(options.localOpenAI);
	if (config.provider === 'cloud-openai') return createOpenAIProvider(options.openAI);
	if (config.provider === 'cloud-anthropic') return createAnthropicProvider(options.anthropic);
	if (config.provider === 'cloud-gemini') return createGeminiProvider(options.gemini);
	if (config.provider === 'cloud-xai') return createXaiProvider(options.xai);
	throw Object.assign(new Error(`Provider ${config.provider} does not support model-backed execution.`), { status: 400 });
}

export function isModelBackedProvider(id) {
	return ['cloud-openai', 'cloud-anthropic', 'cloud-gemini', 'cloud-xai', 'local-ollama', 'local-openai-compatible'].includes(id);
}
