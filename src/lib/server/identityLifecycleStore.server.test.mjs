import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authenticateScimCredential, createIdentityLifecycleStore, createTenantIdentityLifecycleStore } from './identityLifecycleStore.server.js';

const config = { url: 'https://project.supabase.co', key: 'server-secret', tenantId: '00000000-0000-4000-8000-000000000001' };

test('hashes one-time SCIM credentials before calling service RPCs', async () => {
	const calls = [];
	const store = createIdentityLifecycleStore({ config, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ status: 'active' }); } });
	const token = `kcev_scim_${'secret-material'.repeat(4)}`;
	await store.configureScim('Okta production', token, 'admin@example.com');
	await store.authenticateScimToken(token);
	const configured = JSON.parse(calls[0].init.body);
	const authenticated = JSON.parse(calls[1].init.body);
	assert.match(configured.p_token_sha256, /^[a-f0-9]{64}$/);
	assert.equal(authenticated.p_token_sha256, configured.p_token_sha256);
	assert.doesNotMatch(calls[0].init.body + calls[1].init.body, /secret-material/);
	assert.match(calls[0].url, /rpc\/upsert_agent_scim_connection$/);
	assert.match(calls[1].url, /rpc\/authenticate_agent_scim_token$/);
});

test('binds invitation and SCIM lifecycle operations to the authenticated tenant', async () => {
	const calls = [];
	const tenantId = '00000000-0000-4000-8000-000000000002';
	const store = createTenantIdentityLifecycleStore(tenantId, { config, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(url.includes('list_') ? [] : { id: 'resource-id' }); } });
	await store.createInvitation({ email: 'alice@example.com', role: 'operator', expiresAt: '2026-07-20T00:00:00.000Z' }, 'admin@example.com');
	await store.listScimUsers({ userName: 'alice@example.com', offset: 4, limit: 20 });
	await store.upsertScimUser(null, { userName: 'alice@example.com', displayName: 'Alice', role: 'operator', active: true }, 'scim:connection');
	for (const call of calls) assert.equal(JSON.parse(call.init.body).p_tenant_id, tenantId);
	assert.deepEqual(JSON.parse(calls[1].init.body), { p_tenant_id: tenantId, p_user_name: 'alice@example.com', p_offset: 4, p_limit: 20 });
});

test('digests OIDC subject evidence and never transmits the raw provider subject', async () => {
	const calls = [];
	const store = createIdentityLifecycleStore({ config, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ id: 'alice@example.com' }); } });
	await store.redeemOidcInvitation(config.tenantId, { email: 'alice@example.com', displayName: 'Alice', issuer: 'https://idp.example.com', subject: 'provider-secret-subject' });
	const body = JSON.parse(calls[0].init.body);
	assert.match(body.p_subject_sha256, /^[a-f0-9]{64}$/);
	assert.doesNotMatch(calls[0].init.body, /provider-secret-subject/);
	assert.match(calls[0].url, /rpc\/redeem_agent_oidc_invitation$/);
});

test('fails closed for missing, disabled, and unavailable SCIM credentials', async () => {
	assert.equal((await authenticateScimCredential('short', { store: {} })).status, 401);
	assert.equal((await authenticateScimCredential('x'.repeat(40), { store: { authenticateScimToken: async () => null } })).status, 401);
	assert.equal((await authenticateScimCredential('x'.repeat(40), { store: { authenticateScimToken: async () => { throw new Error('offline'); } } })).status, 503);
	const accepted = await authenticateScimCredential('x'.repeat(40), { store: { authenticateScimToken: async () => ({ subject: 'scim:connection', role: 'admin', tenantId: config.tenantId }) } });
	assert.equal(accepted.authenticated, true);
	assert.equal(accepted.method, 'scim');
	assert.equal(accepted.platformAdmin, false);
});
