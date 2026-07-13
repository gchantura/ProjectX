import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditRoute, createAuditStore, recordMutationAudit } from './auditStore.server.js';

const config = { url: 'https://project.supabase.co', key: 'server-secret', tenantId: '00000000-0000-4000-8000-000000000001' };

test('audit store keeps requests tenant scoped and credentials out of mutation evidence', async () => {
	const calls = [];
	const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ sequence: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }); };
	const store = createAuditStore({ config, fetchImpl });
	await recordMutationAudit({ store, identity: { subject: 'alice@example.com', role: 'admin', token: 'never-store-me' }, method: 'POST', pathname: '/api/settings', status: 200, requestId: 'req-1', traceId: 'a'.repeat(32) });
	const body = JSON.parse(calls[0].init.body);
	assert.equal(body.p_tenant_id, config.tenantId);
	assert.deepEqual(body.p_event.metadata, { status: 200 });
	assert.equal(body.p_event.action, 'POST /api/settings');
	assert.doesNotMatch(calls[0].init.body, /never-store-me/);
});

test('audit route normalizes opaque resource identifiers', () => {
	assert.equal(auditRoute('/api/runs/run-abc-123/approval'), '/api/runs/:runId/approval');
	assert.equal(auditRoute('/api/admin/identities/alice%40example.com'), '/api/admin/identities/:identityId');
});

test('safe methods and unauthenticated requests do not create mutation evidence', async () => {
	let calls = 0;
	const store = { append: async () => { calls += 1; } };
	assert.equal(await recordMutationAudit({ store, identity: { subject: 'a', role: 'admin' }, method: 'GET' }), 'skipped');
	assert.equal(await recordMutationAudit({ store, identity: null, method: 'POST' }), 'skipped');
	assert.equal(calls, 0);
});
