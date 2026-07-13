import { randomUUID } from 'node:crypto';
import { ProviderError } from './openai.server.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

export function createOllamaProvider(options = {}) {
	const baseUrl = String(options.baseUrl ?? process.env.KCEV_OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const timeoutMs = positiveInteger(options.timeoutMs, 180_000);
	return {
		id: 'local-ollama',
		async capabilities() { return { nativeToolCalling: true, jsonMode: true, contextWindow: 262_144, streaming: true, visionInput: true }; },
		async listModels({ signal } = {}) {
			const body = await requestJson(fetchImpl, `${baseUrl}/api/tags`, { method: 'GET', signal, timeoutMs: 10_000 });
			return (body.models ?? []).map((model) => ({ name: model.name, size: model.size, details: model.details ?? {} }));
		},
		async completeStructured(request) {
			validateRequest(request);
			const requestId = request.requestId ?? randomUUID();
			const body = await requestJson(fetchImpl, `${baseUrl}/api/chat`, {
				method: 'POST', signal: request.signal, timeoutMs,
				body: {
					model: request.model,
					messages: request.messages.map(({ role, content }) => ({ role: role === 'developer' ? 'system' : role, content })),
					format: request.schema,
					stream: false,
					options: { temperature: 0, num_predict: positiveInteger(request.maxOutputTokens, 4096) }
				}
			});
			let value;
			try { value = JSON.parse(body?.message?.content ?? ''); }
			catch (cause) { throw new ProviderError('Ollama returned malformed structured output.', { code: 'malformed_output', requestId, cause }); }
			return {
				value, rawResponse: JSON.stringify(body), providerResponseId: body.created_at ?? null, requestId,
				model: body.model ?? request.model, attempts: 1,
				usage: { inputTokens: Number(body.prompt_eval_count) || 0, outputTokens: Number(body.eval_count) || 0, totalTokens: (Number(body.prompt_eval_count) || 0) + (Number(body.eval_count) || 0) }
			};
		}
	};
}

async function requestJson(fetchImpl, url, { method, body, signal, timeoutMs }) {
	const timeoutController = new AbortController();
	const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
	const combined = AbortSignal.any([timeoutController.signal, ...(signal ? [signal] : [])]);
	try {
		const response = await fetchImpl(url, { method, signal: combined, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) throw new ProviderError(String(payload?.error ?? `Ollama request failed with status ${response.status}.`).slice(0, 300), { code: 'ollama_error', status: response.status, retryable: response.status >= 500 });
		return payload;
	} catch (error) {
		if (error instanceof ProviderError) throw error;
		throw new ProviderError(combined.aborted ? (signal?.aborted ? 'Ollama request cancelled.' : 'Ollama request timed out.') : 'Unable to reach Ollama.', { code: combined.aborted ? 'timeout' : 'network_error', status: combined.aborted ? 504 : 502, retryable: !signal?.aborted, cause: error });
	} finally { clearTimeout(timeout); }
}

function validateRequest(request = {}) {
	if (!/^[a-z0-9._:/-]{1,200}$/i.test(String(request.model ?? ''))) throw new ProviderError('A valid Ollama model is required.', { code: 'validation_error', status: 400 });
	if (!request.schema || request.schema.type !== 'object') throw new ProviderError('A root object JSON Schema is required.', { code: 'validation_error', status: 400 });
	if (!Array.isArray(request.messages) || request.messages.length === 0) throw new ProviderError('At least one message is required.', { code: 'validation_error', status: 400 });
}
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
