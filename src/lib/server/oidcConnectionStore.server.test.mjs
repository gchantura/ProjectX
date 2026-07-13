import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createOidcConnectionStore, resolveTenantOidcConfig } from './oidcConnectionStore.server.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const config = { url: 'https://project.supabase.co', key: 'server-secret', tenantId };
const encryptionKey = randomBytes(32);
const connection = { displayName: 'Northwind SSO', issuer: 'https://idp.example.com', clientId: 'northwind-client', clientSecret: 'secret-that-is-long-enough', scopes: 'openid profile email', allowedEndpointOrigins: [] };

test('stores only tenant-bound ciphertext and never returns secrets from metadata reads', async () => {
	const calls = [];
	let ciphertext;
	const store = createOidcConnectionStore({ config, encryptionKey, fetchImpl: async (url, init) => {
		calls.push({ url, init });
		if (url.includes('/rpc/')) { ciphertext = JSON.parse(init.body).p_connection.clientSecretCiphertext; return Response.json({ tenantId, displayName: connection.displayName, secretConfigured: true }); }
		return Response.json([{ tenant_id: tenantId, display_name: connection.displayName, issuer: connection.issuer, client_id: connection.clientId, ...(url.includes('client_secret_ciphertext') ? { client_secret_ciphertext: ciphertext } : {}), scopes: connection.scopes, allowed_endpoint_origins: [], status: 'active', revision: '00000000-0000-4000-8000-000000000010', encryption_key_id: 'legacy' }]);
	} });
	await store.upsert(tenantId, connection, 'admin@example.com');
	const body = calls[0].init.body;
	assert.doesNotMatch(body, new RegExp(connection.clientSecret));
	assert.match(JSON.parse(body).p_connection.clientSecretCiphertext, /^v2\.legacy\./);
	assert.equal(JSON.parse(body).p_connection.encryptionKeyId, 'legacy');
	const metadata = await store.get(tenantId);
	assert.equal(metadata.clientSecret, undefined);
	assert.doesNotMatch(JSON.stringify(metadata), /ciphertext/i);
	assert.doesNotMatch(calls[1].url, /client_secret_ciphertext/);
	assert.equal((await store.get(tenantId, { includeSecret: true })).clientSecret, connection.clientSecret);
});

test('rewraps stale ciphertext with optimistic revision binding and no plaintext payload', async () => {
	const oldKey = randomBytes(32);
	const currentKey = randomBytes(32);
	const oldStore = createOidcConnectionStore({ config, encryptionKeyring: { activeKeyId: 'old', keys: new Map([['old', oldKey]]) }, fetchImpl: async (_url, init) => Response.json({ ciphertext: JSON.parse(init.body).p_connection.clientSecretCiphertext }) });
	const stored = await oldStore.upsert(tenantId, connection, 'admin@example.com');
	let rpcBody;
	const store = createOidcConnectionStore({ config, encryptionKeyring: { activeKeyId: 'current', keys: new Map([['old', oldKey], ['current', currentKey]]) }, fetchImpl: async (url, init) => {
		if (url.includes('reencrypt_agent_oidc_connection')) { rpcBody = JSON.parse(init.body); return Response.json({ encryptionKeyId: 'current' }); }
		return Response.json([{ tenant_id: tenantId, revision: '00000000-0000-4000-8000-000000000010', encryption_key_id: 'old', client_secret_ciphertext: stored.ciphertext }]);
	} });
	const [record] = await store.rotationInventory();
	await store.reencrypt(record, 'platform:key-rotation');
	assert.equal(rpcBody.p_expected_revision, record.revision);
	assert.equal(rpcBody.p_encryption_key_id, 'current');
	assert.match(rpcBody.p_ciphertext, /^v2\.current\./);
	assert.doesNotMatch(JSON.stringify(rpcBody), new RegExp(connection.clientSecret));
});

test('reports key retirement posture without selecting encrypted payloads', async () => {
	let requestedUrl;
	let requestedBody;
	const store = createOidcConnectionStore({ config, encryptionKeyring: { activeKeyId: 'current', keys: new Map([['current', randomBytes(32)]]) }, fetchImpl: async (url, init) => {
		requestedUrl = url;
		requestedBody = init.body;
		return Response.json({ activeKeyId: 'current', total: 2, pending: 1, byKey: { current: 1, old: 1 } });
	} });
	assert.deepEqual(await store.keyRotationStatus(), { activeKeyId: 'current', total: 2, pending: 1, byKey: { current: 1, old: 1 } });
	assert.match(requestedUrl, /get_agent_oidc_key_rotation_status/);
	assert.doesNotMatch(`${requestedUrl}${requestedBody}`, /ciphertext|tenant_id|revision/i);
});

test('streams rotation inventory in bounded pages', async () => {
	const urls = [];
	const rows = [1, 2, 3].map((index) => ({ tenant_id: `00000000-0000-4000-8000-00000000000${index}`, revision: `r${index}`, encryption_key_id: 'old', client_secret_ciphertext: `opaque-${index}` }));
	const store = createOidcConnectionStore({ config, encryptionKeyring: { activeKeyId: 'current', keys: new Map([['current', randomBytes(32)]]) }, fetchImpl: async (url) => {
		urls.push(url);
		return Response.json(urls.length === 1 ? rows.slice(0, 2) : rows.slice(2));
	} });
	const pages = [];
	for await (const page of store.rotationInventoryPages({ pageSize: 2 })) pages.push(page);
	assert.deepEqual(pages.map((page) => page.length), [2, 1]);
	assert.match(urls[0], /order=tenant_id\.asc&limit=2/);
	assert.match(urls[1], /tenant_id=gt\.00000000-0000-4000-8000-000000000002&limit=2/);
});

test('resolves tenant configuration and denies cross-tenant environment fallback', async () => {
	const stored = { ...connection, tenantId, status: 'active', revision: '00000000-0000-4000-8000-000000000010' };
	const resolved = await resolveTenantOidcConfig(tenantId, { store: { get: async () => stored }, env: {} });
	assert.equal(resolved.issuer, connection.issuer);
	assert.equal(resolved.source, 'tenant');
	assert.equal(await resolveTenantOidcConfig('00000000-0000-4000-8000-000000000002', { store: { get: async () => undefined }, env: { SUPABASE_TENANT_ID: tenantId, KCEV_OIDC_ISSUER: connection.issuer, KCEV_OIDC_CLIENT_ID: connection.clientId, KCEV_OIDC_CLIENT_SECRET: connection.clientSecret } }), null);
	assert.equal(await resolveTenantOidcConfig(tenantId, { store: { get: async () => ({ ...stored, status: 'disabled' }) }, env: {} }), null);
});
