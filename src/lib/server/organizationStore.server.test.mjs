import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOrganizationStore } from './organizationStore.server.js';

const config = { url: 'https://project.supabase.co', key: 'server-secret', tenantId: '00000000-0000-4000-8000-000000000001' };

test('resolves OIDC organization bindings by server-side slug', async () => {
	const calls = [];
	const row = { id: config.tenantId, name: 'Northwind', slug: 'northwind-engineering', status: 'active', created_at: 'now', updated_at: 'now' };
	const store = createOrganizationStore({ config, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json([row]); } });
	assert.equal((await store.findBySlug(row.slug)).id, config.tenantId);
	assert.match(calls[0].url, /agent_tenants\?slug=eq\.northwind-engineering/);
	assert.doesNotMatch(calls[0].url, /tenant_id/);
});

test('lists organizations without tenant-scoping the platform directory query', async () => {
	const calls = [];
	const store = createOrganizationStore({ config, fetchImpl: async (url, init) => {
		calls.push({ url, init });
		return Response.json([{ id: config.tenantId, name: 'Northwind', slug: 'northwind', status: 'active', created_at: 'now', updated_at: 'now' }]);
	} });
	assert.deepEqual(await store.list(), [{ id: config.tenantId, name: 'Northwind', slug: 'northwind', status: 'active', createdAt: 'now', updatedAt: 'now' }]);
	assert.doesNotMatch(calls[0].url, /tenant_id=eq/);
});

test('provisions through one atomic RPC and transmits only the credential digest', async () => {
	const calls = [];
	const store = createOrganizationStore({ config, fetchImpl: async (url, init) => {
		calls.push({ url, init });
		return Response.json({ organization: { id: config.tenantId }, identity: { id: 'admin@example.com' } });
	} });
	await store.provision({ name: 'Contoso', slug: 'contoso', admin: { id: 'admin@example.com', displayName: 'Admin', tokenSha256: 'a'.repeat(64) } }, 'platform@example.com');
	assert.match(calls[0].url, /rpc\/provision_agent_tenant$/);
	const body = JSON.parse(calls[0].init.body);
	assert.deepEqual(body, { p_name: 'Contoso', p_slug: 'contoso', p_admin: { id: 'admin@example.com', displayName: 'Admin', tokenSha256: 'a'.repeat(64) }, p_actor: 'platform@example.com' });
	assert.doesNotMatch(calls[0].init.body, /kcev_|plaintext|"token"/i);
});

test('changes lifecycle state through the audited service RPC', async () => {
	const calls = [];
	const store = createOrganizationStore({ config, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ organization: { id: config.tenantId, status: 'suspended' }, changed: true }); } });
	const result = await store.updateStatus(config.tenantId, 'suspended', 'platform@example.com');
	assert.equal(result.organization.status, 'suspended');
	assert.match(calls[0].url, /rpc\/set_agent_tenant_status$/);
	assert.deepEqual(JSON.parse(calls[0].init.body), { p_tenant_id: config.tenantId, p_status: 'suspended', p_actor: 'platform@example.com' });
});
