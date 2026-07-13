import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAnthropicProvider } from './anthropic.server.js';
import { ProviderError } from './openai.server.js';

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const request = { model: 'claude-sonnet-5', schemaName: 'result', schema, messages: [{ role: 'system', content: 'Be exact.' }, { role: 'user', content: 'Return success.' }] };

describe('Anthropic provider adapter', () => {
	it('sends native output_config JSON schema and captures usage', async () => {
		let sent;
		const provider = createAnthropicProvider({ apiKey: 'test-key', maxRetries: 0, fetchImpl: async (_url, init) => {
			sent = { headers: init.headers, body: JSON.parse(init.body) };
			return response({ id: 'msg_1', model: 'claude-sonnet-5', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 9, output_tokens: 4 } }, 200, { 'request-id': 'req_1' });
		} });
		const result = await provider.completeStructured(request);
		assert.equal(sent.headers['x-api-key'], 'test-key');
		assert.equal(sent.body.output_config.format.type, 'json_schema');
		assert.deepEqual(sent.body.output_config.format.schema, schema);
		assert.equal(sent.body.system, 'Be exact.');
		assert.deepEqual(result.value, { ok: true });
		assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 4, totalTokens: 13 });
		assert.equal(result.requestId, 'req_1');
	});

	it('fails closed for malformed output and missing credentials', async () => {
		const malformed = createAnthropicProvider({ apiKey: 'test-key', maxRetries: 0, fetchImpl: async () => response({ content: [{ type: 'text', text: 'not-json' }] }) });
		await assert.rejects(() => malformed.completeStructured(request), (error) => error instanceof ProviderError && error.code === 'malformed_output');
		const missing = createAnthropicProvider({ apiKey: '', fetchImpl: async () => { throw new Error('must not run'); } });
		await assert.rejects(() => missing.completeStructured(request), (error) => error.code === 'missing_api_key' && error.status === 503);
	});
});

function response(body, status = 200, headers = {}) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
