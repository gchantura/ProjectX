import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDistributedRateLimitStore } from './rateLimitStore.server.js';

const config = { url: 'https://project.supabase.co', key: 'server-secret', tenantId: '00000000-0000-4000-8000-000000000001' };

test('distributed limiter sends only a digest and tenant-scoped parameters', async () => {
	let captured;
	const store = createDistributedRateLimitStore({ config, fetchImpl: async (url, init) => { captured = { url, init }; return new Response(JSON.stringify({ allowed: true, remaining: 9, resetAt: 1000, backend: 'supabase-postgres' }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
	const result = await store.consume('203.0.113.42', 10);
	const body = JSON.parse(captured.init.body);
	assert.equal(result.backend, 'supabase-postgres');
	assert.equal(body.p_tenant_id, config.tenantId);
	assert.match(body.p_key_sha256, /^[a-f0-9]{64}$/);
	assert.doesNotMatch(captured.init.body, /203\.0\.113\.42/);
	assert.equal(body.p_window_seconds, 60);
});
