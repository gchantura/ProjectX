import { randomUUID } from 'node:crypto';
import { ProviderError } from './openai.server.js';

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export function createXaiProvider(options = {}) {
	const apiKey = options.apiKey ?? process.env.XAI_API_KEY;
	const baseUrl = String(options.baseUrl ?? process.env.XAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const timeoutMs = positiveInteger(options.timeoutMs, 60_000);
	const maxRetries = nonNegativeInteger(options.maxRetries, 2);
	if (typeof fetchImpl !== 'function') throw new ProviderError('A fetch implementation is required.', { code: 'configuration_error', status: 500 });

	return {
		id: 'cloud-xai',
		async capabilities() {
			return { nativeToolCalling: true, jsonMode: true, contextWindow: 256_000, streaming: true, visionInput: true };
		},
		async completeStructured(request) {
			if (!apiKey) throw new ProviderError('XAI_API_KEY is not configured on the server.', { code: 'missing_api_key', status: 503 });
			validateStructuredRequest(request);
			const clientRequestId = request.requestId ?? randomUUID();
			const payload = {
				model: request.model,
				messages: request.messages.map(({ role, content }) => ({ role: role === 'developer' ? 'system' : role, content })),
				max_tokens: positiveInteger(request.maxOutputTokens, 4096),
				response_format: { type: 'json_schema', json_schema: { name: request.schemaName, schema: request.schema, strict: true } }
			};

			let lastError;
			for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
				try {
					const response = await requestJson(fetchImpl, `${baseUrl}/chat/completions`, { apiKey, payload, clientRequestId, timeoutMs, signal: request.signal });
					return parseResponse(response.body, { requestId: response.requestId ?? clientRequestId, model: request.model, attempts: attempt + 1 });
				} catch (error) {
					lastError = normalizeError(error, clientRequestId);
					if (!lastError.retryable || attempt === maxRetries || request.signal?.aborted) throw lastError;
					await backoff(attempt, request.signal);
				}
			}
			throw lastError;
		}
	};
}

async function requestJson(fetchImpl, url, { apiKey, payload, clientRequestId, timeoutMs, signal }) {
	const timeoutController = new AbortController();
	const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
	const combined = AbortSignal.any([timeoutController.signal, ...(signal ? [signal] : [])]);
	try {
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-client-request-id': clientRequestId },
			body: JSON.stringify(payload),
			signal: combined
		});
		const requestId = response.headers?.get?.('x-request-id') ?? clientRequestId;
		const body = await response.json().catch(() => ({}));
		if (!response.ok) {
			throw new ProviderError(safeMessage(body, response.status), {
				code: String(body?.error?.code ?? body?.error?.type ?? 'api_error'),
				status: response.status,
				retryable: RETRYABLE_STATUS.has(response.status),
				requestId
			});
		}
		return { body, requestId };
	} catch (error) {
		if (error instanceof ProviderError) throw error;
		if (combined.aborted) throw new ProviderError(signal?.aborted ? 'xAI request cancelled.' : 'xAI request timed out.', { code: signal?.aborted ? 'cancelled' : 'timeout', status: signal?.aborted ? 499 : 504, retryable: !signal?.aborted, requestId: clientRequestId, cause: error });
		throw new ProviderError('Unable to reach xAI.', { code: 'network_error', status: 502, retryable: true, requestId: clientRequestId, cause: error });
	} finally {
		clearTimeout(timeout);
	}
}

function parseResponse(body, metadata) {
	const message = body?.choices?.[0]?.message;
	if (message?.refusal) throw new ProviderError('Grok refused the structured request.', { code: 'refusal', status: 422, requestId: metadata.requestId });
	const outputText = message?.content;
	if (!outputText) throw new ProviderError('xAI returned no structured output.', { code: 'empty_output', status: 502, requestId: metadata.requestId });
	let value;
	try { value = JSON.parse(outputText); } catch (cause) {
		throw new ProviderError('xAI returned malformed structured output.', { code: 'malformed_output', status: 502, requestId: metadata.requestId, cause });
	}
	return {
		value,
		providerResponseId: body.id ?? null,
		requestId: metadata.requestId,
		model: body.model ?? metadata.model,
		attempts: metadata.attempts,
		usage: {
			inputTokens: Number(body?.usage?.prompt_tokens) || 0,
			outputTokens: Number(body?.usage?.completion_tokens) || 0,
			totalTokens: Number(body?.usage?.total_tokens) || 0
		}
	};
}

function validateStructuredRequest(request = {}) {
	if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(String(request.model ?? ''))) throw new ProviderError('A valid xAI model is required.', { code: 'validation_error', status: 400 });
	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(request.schemaName ?? ''))) throw new ProviderError('A valid schema name is required.', { code: 'validation_error', status: 400 });
	if (!request.schema || request.schema.type !== 'object') throw new ProviderError('A root object JSON Schema is required.', { code: 'validation_error', status: 400 });
	if (!Array.isArray(request.messages) || request.messages.length === 0) throw new ProviderError('At least one message is required.', { code: 'validation_error', status: 400 });
	for (const message of request.messages) {
		if (!['system', 'developer', 'user', 'assistant'].includes(message?.role) || typeof message?.content !== 'string') throw new ProviderError('Messages must contain a supported role and text content.', { code: 'validation_error', status: 400 });
	}
}

function safeMessage(body, status) {
	const message = String(body?.error?.message ?? '').replace(/xai-[a-zA-Z0-9_-]+/g, '[REDACTED]').slice(0, 300);
	return message || `xAI request failed with status ${status}.`;
}

function normalizeError(error, requestId) { return error instanceof ProviderError ? error : new ProviderError('Unexpected xAI provider failure.', { requestId, cause: error }); }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function nonNegativeInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback; }
function backoff(attempt, signal) {
	const delayMs = Math.min(250 * 2 ** attempt + Math.floor(Math.random() * 100), 2_000);
	return new Promise((resolve) => {
		const timeout = setTimeout(resolve, delayMs);
		signal?.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true });
	});
}
