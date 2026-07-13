import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { clearMemoriesForTest, forget, formatMemoryContext, recall, recordVerifiedRunMemory, remember } from './memoryStore.server.js';

let storeDir;
before(async () => { storeDir = await mkdtemp(join(tmpdir(), 'kcevagent-memory-')); process.env.KCEV_AGENT_DATA_DIR = storeDir; });
beforeEach(clearMemoriesForTest);
after(async () => { delete process.env.KCEV_AGENT_DATA_DIR; await rm(storeDir, { force: true, recursive: true }); });

describe('durable agent memory', () => {
	it('retrieves relevant scoped memories under a context budget', async () => {
		await remember({ content: 'PostgreSQL is the production persistence target for clustered workers.', tags: ['database', 'production'], importance: 0.9 });
		await remember({ content: 'The interface uses a dark operator console.', tags: ['ui'], importance: 0.8 });
		const results = await recall('production database and PostgreSQL workers', { maxChars: 2000 });
		assert.equal(results.length, 1);
		assert.match(results[0].content, /PostgreSQL/);
		assert.match(formatMemoryContext(results), /UNTRUSTED DURABLE MEMORY/);
	});
	it('rejects likely secrets and supports explicit deletion', async () => {
		await assert.rejects(() => remember({ content: `api_key=${'x'.repeat(40)}` }), /secret/);
		const memory = await remember({ content: 'Safe durable preference.' });
		assert.equal(await forget(memory.id), true);
		assert.deepEqual(await recall('durable preference'), []);
	});
	it('isolates recall, listing, and deletion between projects', async () => {
		const alpha = await remember({ projectId: 'project-alpha', content: 'Alpha uses PostgreSQL for production.', tags: ['database'] });
		const beta = await remember({ projectId: 'project-beta', content: 'Beta uses PostgreSQL for analytics.', tags: ['database'] });
		assert.deepEqual((await recall('PostgreSQL', { projectId: 'project-alpha' })).map((memory) => memory.id), [alpha.id]);
		assert.deepEqual((await recall('PostgreSQL', { projectId: 'project-beta' })).map((memory) => memory.id), [beta.id]);
		assert.equal(await forget(beta.id, { projectId: 'project-alpha' }), false);
		assert.equal(await forget(beta.id, { projectId: 'project-beta' }), true);
	});
	it('records only verified run outcomes and deduplicates by run idempotently', async () => {
		const run = { id: 'run-memory-test', status: 'verified', task: 'Validate memory', config: { domain: 'coding', provider: 'deterministic-local' }, steps: [{ title: 'Check result', verification: { evidence: ['command:npm run ai:check'] } }] };
		const first = await recordVerifiedRunMemory(run);
		const second = await recordVerifiedRunMemory(run);
		assert.equal(second.id, first.id);
		assert.equal((await recall('Validate memory check result')).length, 1);
	});

	it('routes memory operations to Supabase when configured', async () => {
		const originalEnv = {
			KCEV_MEMORY_BACKEND: process.env.KCEV_MEMORY_BACKEND,
			SUPABASE_URL: process.env.SUPABASE_URL,
			SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
			SUPABASE_TENANT_ID: process.env.SUPABASE_TENANT_ID
		};
		const originalFetch = globalThis.fetch;
		const calls = [];
		try {
			process.env.KCEV_MEMORY_BACKEND = 'supabase';
			process.env.SUPABASE_URL = 'https://project.supabase.co';
			process.env.SUPABASE_SECRET_KEY = 'server-secret';
			process.env.SUPABASE_TENANT_ID = '00000000-0000-4000-8000-000000000001';
			globalThis.fetch = async (url, init) => {
				calls.push({ url, init });
				if (String(url).includes('persist_agent_memory')) return Response.json(JSON.parse(init.body).p_memory);
				if (init.method === 'DELETE') return Response.json([{ id: 'mem-remote' }]);
				return Response.json([{ expires_at: null, memory_json: { id: 'mem-remote', projectId: 'project-remote', scope: 'project-remote', kind: 'fact', content: 'Remote Supabase memory for production workers.', tags: ['production'], importance: 0.9, createdAt: '2026-07-11T10:00:00.000Z', updatedAt: '2026-07-11T10:00:00.000Z', expiresAt: null } }]);
			};

			const memory = await remember({ projectId: 'project-remote', content: 'Remote Supabase memory for production workers.', tags: ['production'], importance: 0.9 });
			const recalled = await recall('production workers', { projectId: 'project-remote' });
			assert.match(calls.find((call) => String(call.url).includes('persist_agent_memory')).url, /persist_agent_memory/);
			assert.equal(memory.content, 'Remote Supabase memory for production workers.');
			assert.deepEqual(recalled.map((item) => item.id), ['mem-remote']);
			assert.equal(await forget('mem-remote', { projectId: 'project-remote' }), true);
		} finally {
			for (const [key, value] of Object.entries(originalEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			globalThis.fetch = originalFetch;
		}
	});
});
