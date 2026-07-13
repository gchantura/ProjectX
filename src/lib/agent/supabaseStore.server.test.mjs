import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSupabaseApprovalStore, createSupabaseLeaseStore, createSupabaseMemoryStore, createSupabaseRunStore, getSupabaseConfig } from './supabaseStore.server.js';
import { withTenantContext } from '../server/tenantContext.js';

const config = { url: 'https://project.supabase.co', key: 'server-secret', tenantId: '00000000-0000-4000-8000-000000000001' };

test('requires a secure server configuration and valid tenant UUID', () => {
	assert.equal(getSupabaseConfig({ SUPABASE_URL: 'http://project.supabase.co', SUPABASE_SECRET_KEY: 'x', SUPABASE_TENANT_ID: config.tenantId }), null);
	assert.equal(getSupabaseConfig({ SUPABASE_URL: config.url, SUPABASE_SECRET_KEY: 'x', SUPABASE_TENANT_ID: 'invalid' }), null);
});

test('derives tenant scope from authenticated request context instead of request input', async () => {
	const env = { SUPABASE_URL: config.url, SUPABASE_SECRET_KEY: config.key, SUPABASE_TENANT_ID: config.tenantId };
	const secondTenant = '00000000-0000-4000-8000-000000000002';
	await withTenantContext({ id: secondTenant, name: 'Contoso' }, async () => {
		assert.equal(getSupabaseConfig(env).tenantId, secondTenant);
		const store = createSupabaseRunStore({ env, fetchImpl: async (url) => {
			assert.match(url, new RegExp(`tenant_id=eq\\.${secondTenant}`));
			return Response.json([]);
		} });
		await store.list({ limit: 1 });
	});
	assert.equal(getSupabaseConfig(env).tenantId, config.tenantId);
});

test('persists runs through the transactional RPC without leaking credentials into payload', async () => {
	const captured = [];
	const store = createSupabaseRunStore({ config, fetchImpl: async (url, init) => {
		captured.push({ url, init });
		return new Response(null, { status: 204 });
	} });
	const run = { id: 'run-test', task: 'test', status: 'completed', config: { projectId: 'project-test', projectName: 'Test project' } };
	await store.persist(run);
	assert.match(captured[0].url, /\/rest\/v1\/rpc\/persist_agent_project$/);
	assert.match(captured[1].url, /\/rest\/v1\/rpc\/persist_agent_run$/);
	assert.equal(captured[1].init.headers.apikey, config.key);
	assert.deepEqual(JSON.parse(captured[1].init.body), { p_tenant_id: config.tenantId, p_run: run });
	assert.doesNotMatch(captured[1].init.body, /server-secret/);
});

test('reads tenant and project-scoped run records', async () => {
	const store = createSupabaseRunStore({ config, fetchImpl: async (url) => {
		assert.match(url, /tenant_id=eq\.00000000/);
		assert.match(url, /project_id=eq\.project-test/);
		return Response.json([{ run_json: { id: 'run-test' } }]);
	} });
	assert.deepEqual(await store.get('run-test', { projectId: 'project-test' }), { id: 'run-test' });
});

test('persists and lists tenant-scoped run events', async () => {
	const calls = [];
	const store = createSupabaseRunStore({ config, fetchImpl: async (url, init) => {
		calls.push({ url, init });
		if (init.method === 'POST') return new Response(null, { status: 204 });
		return Response.json([{ position: 0, event_type: 'run_started', payload: { type: 'run_started' }, created_at: '2026-07-11T10:00:00.000Z' }]);
	} });
	await store.persistEvents('run-test', [{ position: 0, type: 'run_started', payload: { type: 'run_started' }, createdAt: '2026-07-11T10:00:00.000Z' }], { projectId: 'project-test' });
	const events = await store.listEvents('run-test', { projectId: 'project-test' });
	assert.match(calls[0].url, /agent_run_events\?on_conflict=tenant_id,run_id,position/);
	assert.equal(calls[0].init.headers.prefer, 'resolution=merge-duplicates');
	assert.deepEqual(JSON.parse(calls[0].init.body)[0], { tenant_id: config.tenantId, project_id: 'project-test', run_id: 'run-test', position: 0, event_type: 'run_started', payload: { type: 'run_started' }, created_at: '2026-07-11T10:00:00.000Z' });
	assert.deepEqual(events, [{ position: 0, type: 'run_started', payload: { type: 'run_started' }, createdAt: '2026-07-11T10:00:00.000Z' }]);
});

test('claims, heartbeats, and releases tenant-scoped run leases through RPCs', async () => {
	const calls = [];
	const responses = [
		{ acquired: true, runId: 'run-test', leaseToken: '00000000-0000-4000-8000-000000000010', ownerId: 'worker:test', expiresAt: '2026-07-13T00:05:00.000Z', attempt: 1 },
		{ renewed: true, runId: 'run-test', expiresAt: '2026-07-13T00:06:00.000Z', attempt: 1 },
		true
	];
	const store = createSupabaseLeaseStore({ config, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(responses.shift()); } });
	await store.claim({ projectId: 'project-test', runId: 'run-test', ownerId: 'worker:test', ttlSeconds: 300 });
	await store.heartbeat({ runId: 'run-test', leaseToken: '00000000-0000-4000-8000-000000000010', ttlSeconds: 300 });
	assert.equal(await store.release({ runId: 'run-test', leaseToken: '00000000-0000-4000-8000-000000000010' }), true);
	assert.match(calls[0].url, /rpc\/claim_agent_run_lease$/);
	assert.match(calls[1].url, /rpc\/heartbeat_agent_run_lease$/);
	assert.match(calls[2].url, /rpc\/release_agent_run_lease$/);
	assert.equal(JSON.parse(calls[0].init.body).p_tenant_id, config.tenantId);
	assert.doesNotMatch(calls.map((call) => call.init.body).join(''), /server-secret/);
});

test('reports active durable lease depth for readiness', async () => {
	const store = createSupabaseLeaseStore({ config, fetchImpl: async (url, init) => {
		assert.equal(init.method, 'GET');
		assert.match(url, /agent_run_leases\?tenant_id=eq\./);
		assert.match(url, /expires_at=gt\./);
		return Response.json([{ run_id: 'run-one' }, { run_id: 'run-two' }]);
	} });
	assert.deepEqual(await store.status({ now: new Date('2026-07-13T00:00:00.000Z') }), { activeLeases: 2 });
});

test('persists and consumes one-time run approvals without exposing token material', async () => {
	const calls = [];
	const responses = [
		{ id: '00000000-0000-4000-8000-000000000020', runId: 'run-test', planSha256: 'a'.repeat(64), decision: 'pending' },
		{ approved: true, id: '00000000-0000-4000-8000-000000000020', runId: 'run-test', decision: 'approved' },
		{ rejected: false, runId: 'run-test' }
	];
	const store = createSupabaseApprovalStore({ config, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(responses.shift()); } });
	await store.request({ projectId: 'project-test', runId: 'run-test', planSha256: 'a'.repeat(64), tokenSha256: 'b'.repeat(64), actor: 'operator', expiresAt: '2026-07-13T00:30:00.000Z' });
	await store.consume({ projectId: 'project-test', runId: 'run-test', planSha256: 'a'.repeat(64), tokenSha256: 'b'.repeat(64), actor: 'operator' });
	await store.reject({ projectId: 'project-test', runId: 'run-test', actor: 'operator' });
	assert.match(calls[0].url, /rpc\/request_agent_run_approval$/);
	assert.match(calls[1].url, /rpc\/consume_agent_run_approval$/);
	assert.match(calls[2].url, /rpc\/reject_agent_run_approval$/);
	assert.doesNotMatch(calls.map((call) => call.init.body).join(''), /server-secret/);
});

test('persists tenant-scoped memories through the transactional RPC', async () => {
	const captured = [];
	const store = createSupabaseMemoryStore({ config, fetchImpl: async (url, init) => {
		captured.push({ url, init });
		if (String(url).includes('persist_agent_project')) return new Response(null, { status: 204 });
		return Response.json({ id: 'mem-test', content: 'Remember this.' });
	} });
	const memory = { id: 'mem-test', projectId: 'project-test', scope: 'project-test', kind: 'fact', content: 'Remember this.', tags: ['ops'], importance: 0.8, sourceRunId: null, createdAt: '2026-07-11T10:00:00.000Z', updatedAt: '2026-07-11T10:00:00.000Z', expiresAt: null };
	assert.deepEqual(await store.remember(memory), { id: 'mem-test', content: 'Remember this.' });
	assert.match(captured[0].url, /\/rest\/v1\/rpc\/persist_agent_project$/);
	assert.match(captured[1].url, /\/rest\/v1\/rpc\/persist_agent_memory$/);
	assert.deepEqual(JSON.parse(captured[1].init.body), { p_tenant_id: config.tenantId, p_memory: memory });
	assert.doesNotMatch(captured[1].init.body, /server-secret/);
});

test('lists and deletes tenant-scoped memories', async () => {
	const calls = [];
	const store = createSupabaseMemoryStore({ config, fetchImpl: async (url, init) => {
		calls.push({ url, init });
		if (init.method === 'DELETE') return Response.json([{ id: 'mem-test' }]);
		return Response.json([
			{ expires_at: null, memory_json: { id: 'mem-test', projectId: 'project-test', scope: 'project-test', kind: 'fact', content: 'Active memory.', tags: [], importance: 0.5, createdAt: '2026-07-11T10:00:00.000Z', updatedAt: '2026-07-11T10:00:00.000Z', expiresAt: null } },
			{ expires_at: '2026-01-01T00:00:00.000Z', memory_json: { id: 'mem-old', content: 'Expired.' } }
		]);
	} });
	const memories = await store.list({ projectId: 'project-test', now: new Date('2026-07-11T12:00:00.000Z') });
	assert.deepEqual(memories.map((memory) => memory.id), ['mem-test']);
	assert.equal(await store.forget('mem-test', { projectId: 'project-test' }), true);
	assert.match(calls[0].url, /tenant_id=eq\.00000000/);
	assert.match(calls[0].url, /project_id=eq\.project-test/);
	assert.equal(calls[1].init.headers.prefer, 'return=representation');
});
