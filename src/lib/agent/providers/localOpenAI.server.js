import { randomUUID } from 'node:crypto';
import { ProviderError } from './openai.server.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:1234/v1';
const DEFAULT_API_KEY = 'local-not-required';

export function createLocalOpenAIProvider(options = {}) {
	const baseUrl = String(options.baseUrl ?? process.env.KCEV_LOCAL_OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
	const apiKey = options.apiKey ?? process.env.KCEV_LOCAL_OPENAI_API_KEY ?? DEFAULT_API_KEY;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const timeoutMs = positiveInteger(options.timeoutMs, 180_000);
	if (typeof fetchImpl !== 'function') throw new ProviderError('A fetch implementation is required.', { code: 'configuration_error', status: 500 });

	return {
		id: 'local-openai-compatible',
		async capabilities() { return { nativeToolCalling: true, jsonMode: true, contextWindow: 131_072, streaming: true, visionInput: false }; },
		async listModels({ signal } = {}) {
			const body = await requestJson(fetchImpl, `${baseUrl}/models`, { method: 'GET', apiKey, signal, timeoutMs: 5_000 });
			return (body.data ?? []).map((model) => ({ name: String(model.id ?? model.name ?? ''), details: model })).filter((model) => model.name);
		},
		async completeStructured(request) {
			validateRequest(request);
			const requestId = request.requestId ?? randomUUID();
			const body = await requestJson(fetchImpl, `${baseUrl}/chat/completions`, {
				method: 'POST', apiKey, signal: request.signal, timeoutMs,
				body: {
					model: request.model,
					messages: request.messages.map(({ role, content }) => ({ role: role === 'developer' ? 'system' : role, content })),
					temperature: 0,
					max_tokens: positiveInteger(request.maxOutputTokens, 4096),
					response_format: {
						type: 'json_schema',
						json_schema: { name: request.schemaName ?? 'structured_output', strict: true, schema: request.schema }
					}
				}
			});
			const content = body?.choices?.[0]?.message?.content;
			if (!content) throw new ProviderError('Local OpenAI-compatible runtime returned no structured output.', { code: 'empty_output', requestId });
			let value;
			try { value = JSON.parse(content); }
			catch (cause) { throw new ProviderError('Local OpenAI-compatible runtime returned malformed structured output.', { code: 'malformed_output', requestId, cause }); }
			return {
				value, providerResponseId: body.id ?? null, requestId,
				model: body.model ?? request.model, attempts: 1,
				usage: {
					inputTokens: Number(body?.usage?.prompt_tokens) || 0,
					outputTokens: Number(body?.usage?.completion_tokens) || 0,
					totalTokens: Number(body?.usage?.total_tokens) || 0
				}
			};
		}
	};
}

async function requestJson(fetchImpl, url, { method, apiKey, body, signal, timeoutMs }) {
	const timeoutController = new AbortController();
	const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
	const combined = AbortSignal.any([timeoutController.signal, ...(signal ? [signal] : [])]);
	try {
		const response = await fetchImpl(url, {
			method,
			signal: combined,
			headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) throw new ProviderError(String(payload?.error?.message ?? payload?.error ?? `Local runtime request failed with status ${response.status}.`).slice(0, 300), { code: 'local_openai_error', status: response.status, retryable: response.status >= 500 });
		return payload;
	} catch (error) {
		if (error instanceof ProviderError) throw error;
		throw new ProviderError(combined.aborted ? (signal?.aborted ? 'Local runtime request cancelled.' : 'Local runtime request timed out.') : 'Unable to reach local OpenAI-compatible runtime.', { code: combined.aborted ? 'timeout' : 'network_error', status: combined.aborted ? 504 : 502, retryable: !signal?.aborted, cause: error });
	} finally { clearTimeout(timeout); }
}

function validateRequest(request = {}) {
	if (!/^[a-z0-9._:/-]{1,200}$/i.test(String(request.model ?? ''))) throw new ProviderError('A valid local model is required.', { code: 'validation_error', status: 400 });
	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(request.schemaName ?? 'structured_output'))) throw new ProviderError('A valid schema name is required.', { code: 'validation_error', status: 400 });
	if (!request.schema || request.schema.type !== 'object') throw new ProviderError('A root object JSON Schema is required.', { code: 'validation_error', status: 400 });
	if (!Array.isArray(request.messages) || request.messages.length === 0) throw new ProviderError('At least one message is required.', { code: 'validation_error', status: 400 });
}
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
