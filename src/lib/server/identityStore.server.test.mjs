import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIdentityStore } from './identityStore.server.js';

const config = { url: 'https://project.supabase.co', key: 'server-secret', tenantId: '00000000-0000-4000-8000-000000000001' };

test('resolves a globally unique credential digest to its authoritative tenant without returning token material', async () => {
	const calls = [];
	const store = createIdentityStore({ config, fetchImpl: async (url, init) => {
		calls.push({ url, init });
		return Response.json([{ tenant_id: config.tenantId, id: 'alice@example.com', display_name: 'Alice', role: 'operator', status: 'active', created_at: 'now', updated_at: 'now', agent_tenants: { name: 'Northwind', status: 'active' } }]);
	} });
	const identity = await store.findByTokenSha256('a'.repeat(64));
	assert.equal(identity.id, 'alice@example.com');
	assert.equal(identity.role, 'operator');
	assert.equal(identity.tenantId, config.tenantId);
	assert.equal(identity.accountTenantId, config.tenantId);
	assert.equal(identity.tenantName, 'Northwind');
	assert.equal(identity.tenantStatus, 'active');
	assert.doesNotMatch(calls[0].url, /tenant_id=eq\./);
	assert.match(calls[0].url, /token_sha256=eq\.a{64}/);
	assert.match(calls[0].url, /limit=2/);
	assert.doesNotMatch(JSON.stringify(identity), /token/i);
});

test('reads authoritative organization admission state without browser-controlled tenant input', async () => {
	const calls = [];
	const store = createIdentityStore({ config, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json([{ id: config.tenantId, name: 'Northwind', status: 'suspended' }]); } });
	assert.deepEqual(await store.tenantStatus(config.tenantId), { id: config.tenantId, name: 'Northwind', status: 'suspended' });
	assert.match(calls[0].url, new RegExp(`agent_tenants\\?id=eq\\.${config.tenantId}`));
});

test('fails closed when a credential digest resolves ambiguously', async () => {
	const store = createIdentityStore({ config, fetchImpl: async () => Response.json([
		{ tenant_id: config.tenantId, id: 'alice', display_name: 'Alice', role: 'admin', status: 'active' },
		{ tenant_id: '00000000-0000-4000-8000-000000000002', id: 'alice', display_name: 'Alice', role: 'admin', status: 'active' }
	]) });
	assert.equal(await store.findByTokenSha256('a'.repeat(64)), undefined);
});

test('uses audited RPCs for identity creation and revocation', async () => {
	const calls = [];
	const store = createIdentityStore({ config, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ id: 'alice@example.com', status: 'active' }); } });
	await store.upsert({ id: 'alice@example.com', displayName: 'Alice', role: 'admin', tokenSha256: 'b'.repeat(64) }, 'bootstrap-admin');
	await store.revoke('alice@example.com', 'security-admin');
	const federatedTenantId = '00000000-0000-4000-8000-000000000002';
	await store.recordFederatedLogin('alice@example.com', 'https://idp.example.com', 'provider-subject', { tenantId: federatedTenantId, accountTenantId: config.tenantId });
	assert.match(calls[0].url, /rpc\/upsert_agent_identity$/);
	assert.deepEqual(JSON.parse(calls[0].init.body), { p_tenant_id: config.tenantId, p_identity: { id: 'alice@example.com', displayName: 'Alice', role: 'admin', tokenSha256: 'b'.repeat(64) }, p_actor: 'bootstrap-admin' });
	assert.match(calls[1].url, /rpc\/revoke_agent_identity$/);
	assert.equal(JSON.parse(calls[1].init.body).p_actor, 'security-admin');
	assert.match(calls[2].url, /rpc\/record_agent_federated_login$/);
	assert.equal(JSON.parse(calls[2].init.body).p_tenant_id, federatedTenantId);
	assert.equal(JSON.parse(calls[2].init.body).p_account_tenant_id, config.tenantId);
	assert.match(JSON.parse(calls[2].init.body).p_subject_sha256, /^[a-f0-9]{64}$/);
	assert.doesNotMatch(calls[2].init.body, /provider-subject/);
});

test('uses exact service RPCs for membership switching and administration', async () => {
	const calls = [];
	const store = createIdentityStore({ config, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(url.includes('list_') ? [] : { id: 'alice@example.com', status: 'active' }); } });
	const targetTenantId = '00000000-0000-4000-8000-000000000002';
	await store.listMemberships(config.tenantId, 'alice@example.com');
	await store.resolveMembership(config.tenantId, 'alice@example.com', targetTenantId);
	await store.resolveFederatedMembership(targetTenantId, 'alice@example.com');
	await store.listOrganizationMembers();
	await store.upsertMembership(config.tenantId, 'alice@example.com', 'operator', 'admin@example.com');
	await store.revokeMembership(config.tenantId, 'alice@example.com', 'admin@example.com');
	assert.deepEqual(JSON.parse(calls[1].init.body), { p_account_tenant_id: config.tenantId, p_identity_id: 'alice@example.com', p_tenant_id: targetTenantId });
	assert.deepEqual(JSON.parse(calls[4].init.body), { p_tenant_id: config.tenantId, p_account_tenant_id: config.tenantId, p_identity_id: 'alice@example.com', p_role: 'operator', p_actor: 'admin@example.com' });
	assert.match(calls[5].url, /revoke_agent_organization_membership/);
});

test('verifies the active tenant boundary through a service-only migration contract', async () => {
	const calls = [];
	const store = createIdentityStore({ config, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ tenantName: 'Northwind', requestBound: true, credentialGlobalUniqueness: true, organizationProvisioning: true, tenantLifecycleEnforcement: true, tenantOidcConnections: true, managedSecretRotation: true, organizationMemberships: true, identityLifecycleAutomation: true }); } });
	assert.deepEqual(await store.boundaryStatus(), { tenantName: 'Northwind', requestBound: true, credentialGlobalUniqueness: true, organizationProvisioning: true, tenantLifecycleEnforcement: true, tenantOidcConnections: true, managedSecretRotation: true, organizationMemberships: true, identityLifecycleAutomation: true });
	assert.match(calls[0].url, /rpc\/verify_agent_tenant_boundary$/);
	assert.deepEqual(JSON.parse(calls[0].init.body), { p_tenant_id: config.tenantId });
});
