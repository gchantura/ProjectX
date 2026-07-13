import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, SignJWT } from 'jose';
import { createOidcAuthorization, discoverOidc, exchangeOidcCode, oidcConfig, oidcConfigFingerprint, openOidcTransaction, sealOidcTransaction, validateOidcConfigFingerprint, validateOidcState, verifyOidcIdToken } from './oidc.server.js';

const config = oidcConfig({ KCEV_OIDC_ISSUER: 'https://idp.example.com', KCEV_OIDC_CLIENT_ID: 'kcev-client', KCEV_OIDC_CLIENT_SECRET: 'client-secret', KCEV_OIDC_DISPLAY_NAME: 'Example SSO' });
const metadata = { issuer: config.issuer, authorization_endpoint: 'https://idp.example.com/authorize', token_endpoint: 'https://idp.example.com/token', jwks_uri: 'https://idp.example.com/jwks', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], id_token_signing_alg_values_supported: ['RS256'] };
const organization = { id: '00000000-0000-4000-8000-000000000002', name: 'Northwind Engineering', slug: 'northwind-engineering', status: 'active' };

test('validates discovery and builds signed PKCE authorization state', async () => {
	const discovered = await discoverOidc(config, async () => Response.json(metadata));
	const result = createOidcAuthorization({ config, metadata: discovered, redirectUri: 'https://agent.example.com/api/auth/oidc/callback', organization, returnTo: '/settings', now: new Date('2026-07-13T00:00:00Z') });
	const url = new URL(result.url);
	assert.equal(url.searchParams.get('response_type'), 'code');
	assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
	assert.match(result.transaction.verifier, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(result.transaction.returnTo, '/settings');
	assert.equal(result.transaction.tenantId, organization.id);
	assert.equal(result.transaction.tenantSlug, organization.slug);
	assert.equal(result.transaction.oidcConfigFingerprint, oidcConfigFingerprint(config));
	assert.equal(validateOidcConfigFingerprint(result.transaction, config), true);
	assert.equal(validateOidcConfigFingerprint(result.transaction, { ...config, revision: 'rotated' }), false);
	assert.equal(validateOidcState(result.transaction.state, result.transaction), true);
	assert.equal(validateOidcState('wrong', result.transaction), false);
	const sealed = sealOidcTransaction(result.transaction, 'state-secret-that-is-at-least-32-chars');
	assert.deepEqual(openOidcTransaction(sealed, 'state-secret-that-is-at-least-32-chars', new Date('2026-07-13T00:05:00Z')), result.transaction);
	assert.throws(() => openOidcTransaction(`${sealed}x`, 'state-secret-that-is-at-least-32-chars'), /invalid/i);
	assert.throws(() => openOidcTransaction(sealed, 'state-secret-that-is-at-least-32-chars', new Date('2026-07-13T00:11:00Z')), /expired/i);
	const unbound = sealOidcTransaction({ ...result.transaction, tenantId: undefined }, 'state-secret-that-is-at-least-32-chars');
	assert.throws(() => openOidcTransaction(unbound, 'state-secret-that-is-at-least-32-chars'), /invalid/i);
	assert.throws(() => createOidcAuthorization({ config, metadata, redirectUri: 'https://agent.example.com/api/auth/oidc/callback' }), /organization binding/i);
});

test('rejects issuer mismatch and metadata endpoints outside the allowlist', async () => {
	await assert.rejects(() => discoverOidc(config, async () => Response.json({ ...metadata, issuer: 'https://attacker.example' })), /issuer mismatch/i);
	await assert.rejects(() => discoverOidc(config, async () => Response.json({ ...metadata, jwks_uri: 'https://attacker.example/jwks' })), /untrusted endpoint/i);
});

test('exchanges the code with PKCE and validates the signed ID token', async () => {
	const transaction = createOidcAuthorization({ config, metadata, redirectUri: 'https://agent.example.com/api/auth/oidc/callback', organization }).transaction;
	const exchanged = await exchangeOidcCode({ config, metadata, code: 'one-time-code', transaction, fetchImpl: async (url, init) => {
		assert.equal(url, metadata.token_endpoint);
		assert.match(init.headers.authorization, /^Basic /);
		assert.equal(init.body.get('code_verifier'), transaction.verifier);
		return Response.json({ id_token: 'signed-token' });
	} });
	assert.equal(exchanged.id_token, 'signed-token');
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
	const idToken = await new SignJWT({ nonce: transaction.nonce, email: 'Alice@Example.com', email_verified: true, name: 'Alice' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(config.issuer).setAudience(config.clientId).setSubject('idp-subject-1').setIssuedAt().setExpirationTime('5m').sign(privateKey);
	const claims = await verifyOidcIdToken({ config, metadata, idToken, nonce: transaction.nonce, jwks: createLocalJWKSet({ keys: [jwk] }) });
	assert.deepEqual(claims, { issuer: config.issuer, subject: 'idp-subject-1', email: 'alice@example.com', name: 'Alice' });
	await assert.rejects(() => verifyOidcIdToken({ config, metadata, idToken, nonce: 'wrong', jwks: createLocalJWKSet({ keys: [jwk] }) }), /nonce/i);
});
