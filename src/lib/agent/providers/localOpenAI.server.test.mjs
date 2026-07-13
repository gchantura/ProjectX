import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLocalOpenAIProvider } from './localOpenAI.server.js';

describe('Local OpenAI-compatible provider adapter', () => {
	it('lists models and sends chat-completions JSON schema requests', async () => {
		const calls = [];
		const provider = createLocalOpenAIProvider({
			baseUrl: 'http://127.0.0.1:1234/v1',
			fetchImpl: async (url, init) => {
				calls.push({ url, init });
				if (String(url).endsWith('/models')) {
					return jsonResponse({ data: [{ id: 'local:test' }] });
				}
				const body = JSON.parse(init.body);
				assert.equal(body.model, 'local:test');
				assert.equal(body.response_format.type, 'json_schema');
				assert.equal(body.response_format.json_schema.strict, true);
				return jsonResponse({
					id: 'chatcmpl-local',
					model: body.model,
					choices: [{ message: { content: '{"ready":true}' } }],
					usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
				});
			}
		});

		const models = await provider.listModels();
		const completion = await provider.completeStructured({
			model: 'local:test',
			schemaName: 'probe',
			schema: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'], additionalProperties: false },
			messages: [{ role: 'system', content: 'Return ready=true.' }]
		});

		assert.deepEqual(models.map((model) => model.name), ['local:test']);
		assert.deepEqual(completion.value, { ready: true });
		assert.equal(completion.usage.totalTokens, 5);
		assert.equal(calls.length, 2);
	});

	it('fails closed for malformed local structured output', async () => {
		const provider = createLocalOpenAIProvider({
			fetchImpl: async () => jsonResponse({ choices: [{ message: { content: 'not-json' } }] })
		});
		await assert.rejects(() => provider.completeStructured({
			model: 'local:test',
			schemaName: 'probe',
			schema: { type: 'object' },
			messages: [{ role: 'user', content: 'probe' }]
		}), /malformed structured output/);
	});
});

function jsonResponse(body, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body
	};
}
