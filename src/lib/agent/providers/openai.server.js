import { randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export class ProviderError extends Error {
	constructor(message, { code = 'provider_error', status = 502, retryable = false, requestId, cause } = {}) {
		super(message, { cause });
		this.name = 'ProviderError';
		this.code = code;
		this.status = status;
		this.retryable = retryable;
		this.requestId = requestId;
	}
}

export function createOpenAIProvider(options = {}) {
	const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
	const baseUrl = String(options.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
	const maxRetries = nonNegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES);

	if (typeof fetchImpl !== 'function') throw new ProviderError('A fetch implementation is required.', { code: 'configuration_error', status: 500 });

	return {
		id: 'cloud-openai',
		async capabilities() {
			return { nativeToolCalling: true, jsonMode: true, contextWindow: 400_000, streaming: true, visionInput: true };
		},
		async completeStructured(request) {
			if (!apiKey) throw new ProviderError('OPENAI_API_KEY is not configured on the server.', { code: 'missing_api_key', status: 503 });
			validateStructuredRequest(request);

			const clientRequestId = request.requestId ?? randomUUID();
			const payload = {
				model: request.model,
				input: request.messages.map(({ role, content }) => ({ role, content })),
				max_output_tokens: positiveInteger(request.maxOutputTokens, 4_096),
				text: { format: { type: 'json_schema', name: request.schemaName, strict: true, schema: request.schema } }
			};

			let lastError;
			for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
				try {
					const response = await requestWithTimeout(fetchImpl, `${baseUrl}/responses`, {
						apiKey,
						payload,
						clientRequestId,
						timeoutMs,
						signal: request.signal
					});
					return parseStructuredResponse(response.body, {
						requestId: response.requestId ?? clientRequestId,
						model: request.model,
						attempts: attempt + 1
					});
				} catch (error) {
					lastError = normalizeProviderError(error, clientRequestId);
					if (!lastError.retryable || attempt === maxRetries || request.signal?.aborted) throw lastError;
					await backoff(attempt, request.signal);
				}
			}
			throw lastError;
		}
	};
}

async function requestWithTimeout(fetchImpl, url, { apiKey, payload, clientRequestId, timeoutMs, signal }) {
	const timeoutController = new AbortController();
	const timeout = setTimeout(() => timeoutController.abort(new Error('Provider request timed out.')), timeoutMs);
	const combined = AbortSignal.any([timeoutController.signal, ...(signal ? [signal] : [])]);

	try {
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${apiKey}`,
				'content-type': 'application/json',
				'x-client-request-id': clientRequestId
			},
			body: JSON.stringify(payload),
			signal: combined
		});
		const requestId = response.headers?.get?.('x-request-id') ?? clientRequestId;
		const text = await response.text();
		let body;
		try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }

		if (!response.ok) {
			const retryable = RETRYABLE_STATUS.has(response.status);
			throw new ProviderError(safeApiMessage(body, response.status), {
				code: String(body?.error?.code ?? body?.error?.type ?? 'api_error'),
				status: response.status,
				retryable,
				requestId
			});
		}
		return { body, requestId };
	} catch (error) {
		if (error instanceof ProviderError) throw error;
		if (combined.aborted) {
			throw new ProviderError(signal?.aborted ? 'Provider request cancelled.' : 'Provider request timed out.', {
				code: signal?.aborted ? 'cancelled' : 'timeout',
				status: signal?.aborted ? 499 : 504,
				retryable: !signal?.aborted,
				requestId: clientRequestId,
				cause: error
			});
		}
		throw new ProviderError('Unable to reach the model provider.', { code: 'network_error', status: 502, retryable: true, requestId: clientRequestId, cause: error });
	} finally {
		clearTimeout(timeout);
	}
}

function parseStructuredResponse(body, metadata) {
	if (body?.status === 'incomplete') throw new ProviderError('Provider response was incomplete.', { code: body?.incomplete_details?.reason ?? 'incomplete', status: 502, requestId: metadata.requestId });
	const content = body?.output?.flatMap((item) => item?.content ?? []) ?? [];
	const refusal = content.find((item) => item?.type === 'refusal');
	if (refusal) throw new ProviderError('Model refused the structured request.', { code: 'refusal', status: 422, requestId: metadata.requestId });
	const outputText = content.find((item) => item?.type === 'output_text')?.text ?? body?.output_text;
	if (!outputText) throw new ProviderError('Provider returned no structured output.', { code: 'empty_output', status: 502, requestId: metadata.requestId });
	let value;
	try { value = JSON.parse(outputText); } catch (cause) {
		throw new ProviderError('Provider returned malformed structured output.', { code: 'malformed_output', status: 502, requestId: metadata.requestId, cause });
	}
	return {
		value,
		providerResponseId: body.id ?? null,
		requestId: metadata.requestId,
		model: body.model ?? metadata.model,
		attempts: metadata.attempts,
		usage: {
			inputTokens: Number(body?.usage?.input_tokens) || 0,
			outputTokens: Number(body?.usage?.output_tokens) || 0,
			totalTokens: Number(body?.usage?.total_tokens) || 0
		}
	};
}

function validateStructuredRequest(request = {}) {
	if (!/^[a-zA-Z0-9._-]{1,100}$/.test(String(request.model ?? ''))) throw new ProviderError('A valid model is required.', { code: 'validation_error', status: 400 });
	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(request.schemaName ?? ''))) throw new ProviderError('A valid schema name is required.', { code: 'validation_error', status: 400 });
	if (!request.schema || request.schema.type !== 'object') throw new ProviderError('A root object JSON Schema is required.', { code: 'validation_error', status: 400 });
	if (!Array.isArray(request.messages) || request.messages.length === 0) throw new ProviderError('At least one message is required.', { code: 'validation_error', status: 400 });
	for (const message of request.messages) {
		if (!['system', 'developer', 'user', 'assistant'].includes(message?.role) || typeof message?.content !== 'string') throw new ProviderError('Messages must contain a supported role and text content.', { code: 'validation_error', status: 400 });
	}
}

function safeApiMessage(body, status) {
	const message = String(body?.error?.message ?? '').replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]').slice(0, 300);
	return message || `Model provider request failed with status ${status}.`;
}

function normalizeProviderError(error, requestId) {
	if (error instanceof ProviderError) return error;
	return new ProviderError('Unexpected model provider failure.', { requestId, cause: error });
}

function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function nonNegativeInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback; }
function backoff(attempt, signal) {
	const delayMs = Math.min(250 * 2 ** attempt + Math.floor(Math.random() * 100), 2_000);
	return new Promise((resolve) => {
		const timeout = setTimeout(resolve, delayMs);
		signal?.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true });
	});
}
