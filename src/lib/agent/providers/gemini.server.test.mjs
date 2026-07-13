import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGeminiProvider } from './gemini.server.js';
import { ProviderError } from './openai.server.js';

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const request = { model: 'gemini-3.5-flash', schemaName: 'result', schema, messages: [{ role: 'developer', content: 'Be exact.' }, { role: 'user', content: 'Return success.' }] };

describe('Gemini provider adapter', () => {
	it('sends generateContent response schema and captures usage', async () => {
		let sent;
		const provider = createGeminiProvider({ apiKey: 'test-key', maxRetries: 0, fetchImpl: async (url, init) => {
			sent = { url, headers: init.headers, body: JSON.parse(init.body) };
			return response({ responseId: 'resp_1', modelVersion: 'gemini-3.5-flash', candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }, 200, { 'x-request-id': 'req_1' });
		} });
		const result = await provider.completeStructured(request);
		assert.match(sent.url, /models\/gemini-3\.5-flash:generateContent$/);
		assert.equal(sent.headers['x-goog-api-key'], 'test-key');
		assert.equal(sent.body.generationConfig.responseMimeType, 'application/json');
		assert.deepEqual(sent.body.generationConfig.responseJsonSchema, schema);
		assert.equal(sent.body.systemInstruction.parts[0].text, 'Be exact.');
		assert.deepEqual(result.value, { ok: true });
		assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
	});

	it('fails closed for blocked output and missing credentials', async () => {
		const blocked = createGeminiProvider({ apiKey: 'test-key', maxRetries: 0, fetchImpl: async () => response({ candidates: [{ finishReason: 'SAFETY' }] }) });
		await assert.rejects(() => blocked.completeStructured(request), (error) => error instanceof ProviderError && error.code === 'safety');
		const missing = createGeminiProvider({ apiKey: '', fetchImpl: async () => { throw new Error('must not run'); } });
		await assert.rejects(() => missing.completeStructured(request), (error) => error.code === 'missing_api_key' && error.status === 503);
	});
});

function response(body, status = 200, headers = {}) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
