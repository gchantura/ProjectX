import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError } from './openai.server.js';
import { createXaiProvider } from './xai.server.js';

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const request = { model: 'grok-4.5', schemaName: 'result', schema, messages: [{ role: 'developer', content: 'Be exact.' }, { role: 'user', content: 'Return success.' }] };

describe('xAI provider adapter', () => {
	it('sends chat completions JSON schema and captures usage', async () => {
		let sent;
		const provider = createXaiProvider({ apiKey: 'test-key', maxRetries: 0, fetchImpl: async (_url, init) => {
			sent = { headers: init.headers, body: JSON.parse(init.body) };
			return response({ id: 'chatcmpl_1', model: 'grok-4.5', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 } }, 200, { 'x-request-id': 'req_1' });
		} });
		const result = await provider.completeStructured(request);
		assert.equal(sent.headers.authorization, 'Bearer test-key');
		assert.equal(sent.body.response_format.type, 'json_schema');
		assert.equal(sent.body.response_format.json_schema.strict, true);
		assert.deepEqual(sent.body.response_format.json_schema.schema, schema);
		assert.equal(sent.body.messages[0].role, 'system');
		assert.deepEqual(result.value, { ok: true });
		assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 6, totalTokens: 17 });
	});

	it('fails closed for refusals and missing credentials', async () => {
		const refusal = createXaiProvider({ apiKey: 'test-key', maxRetries: 0, fetchImpl: async () => response({ choices: [{ message: { refusal: 'no' } }] }) });
		await assert.rejects(() => refusal.completeStructured(request), (error) => error instanceof ProviderError && error.code === 'refusal');
		const missing = createXaiProvider({ apiKey: '', fetchImpl: async () => { throw new Error('must not run'); } });
		await assert.rejects(() => missing.completeStructured(request), (error) => error.code === 'missing_api_key' && error.status === 503);
	});
});

function response(body, status = 200, headers = {}) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
