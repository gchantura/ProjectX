import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOpenAIProvider, ProviderError } from './openai.server.js';

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const request = { model: 'gpt-5.5', schemaName: 'result', schema, messages: [{ role: 'user', content: 'Return success.' }] };

describe('OpenAI provider adapter', () => {
	it('sends a strict Responses API schema and captures usage', async () => {
		let sent;
		const provider = createOpenAIProvider({ apiKey: 'test-key', maxRetries: 0, fetchImpl: async (_url, init) => {
			sent = { headers: init.headers, body: JSON.parse(init.body) };
			return response({ id: 'resp_1', model: 'gpt-5.5', output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }], usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } });
		} });
		const result = await provider.completeStructured(request);
		assert.equal(sent.headers.authorization, 'Bearer test-key');
		assert.equal(sent.body.text.format.strict, true);
		assert.equal(sent.body.text.format.type, 'json_schema');
		assert.deepEqual(result.value, { ok: true });
		assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 3, totalTokens: 11 });
	});

	it('retries rate limits and preserves provider request id', async () => {
		let calls = 0;
		const provider = createOpenAIProvider({ apiKey: 'test-key', maxRetries: 1, fetchImpl: async () => {
			calls += 1;
			if (calls === 1) return response({ error: { message: 'slow down', code: 'rate_limit' } }, 429, { 'x-request-id': 'req_rate' });
			return response({ output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }] }, 200, { 'x-request-id': 'req_ok' });
		} });
		const result = await provider.completeStructured(request);
		assert.equal(calls, 2);
		assert.equal(result.requestId, 'req_ok');
		assert.equal(result.attempts, 2);
	});

	it('fails closed for refusals and malformed output', async () => {
		const refusal = createOpenAIProvider({ apiKey: 'test-key', maxRetries: 0, fetchImpl: async () => response({ output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] }) });
		await assert.rejects(() => refusal.completeStructured(request), (error) => error instanceof ProviderError && error.code === 'refusal');
		const malformed = createOpenAIProvider({ apiKey: 'test-key', maxRetries: 0, fetchImpl: async () => response({ output: [{ content: [{ type: 'output_text', text: 'not-json' }] }] }) });
		await assert.rejects(() => malformed.completeStructured(request), (error) => error.code === 'malformed_output');
	});

	it('never sends a request without a server credential', async () => {
		const provider = createOpenAIProvider({ apiKey: '', fetchImpl: async () => { throw new Error('must not run'); } });
		await assert.rejects(() => provider.completeStructured(request), (error) => error.code === 'missing_api_key' && error.status === 503);
	});
});

function response(body, status = 200, headers = {}) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
