import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { decryptTenantSecret, encryptTenantSecret, inspectTenantSecretEnvelope, secretsEncryptionKey, secretsEncryptionKeyring } from './secretEnvelope.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const otherTenantId = '00000000-0000-4000-8000-000000000002';

test('encrypts OIDC secrets with authenticated tenant binding', () => {
	const key = randomBytes(32);
	const envelope = encryptTenantSecret('client-secret-that-is-long-enough', tenantId, key);
	assert.match(envelope, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
	assert.doesNotMatch(envelope, /client-secret/);
	assert.equal(decryptTenantSecret(envelope, tenantId, key), 'client-secret-that-is-long-enough');
	assert.throws(() => decryptTenantSecret(envelope, otherTenantId, key), /integrity/i);
	assert.throws(() => decryptTenantSecret(`${envelope}x`, tenantId, key), /integrity/i);
});

test('accepts only a 32-byte base64url deployment key', () => {
	const encoded = randomBytes(32).toString('base64url');
	assert.equal(secretsEncryptionKey({ KCEV_SECRETS_ENCRYPTION_KEY: encoded }).length, 32);
	assert.equal(secretsEncryptionKey({ KCEV_SECRETS_ENCRYPTION_KEY: 'short' }), null);
});

test('writes key-identified envelopes and reads legacy ciphertext during rotation', () => {
	const oldKey = randomBytes(32);
	const currentKey = randomBytes(32);
	const legacyEnvelope = encryptTenantSecret('legacy-secret-that-is-long-enough', tenantId, oldKey);
	const keyring = { activeKeyId: 'key-2026-07', keys: new Map([['key-2026-07', currentKey]]), legacyKey: oldKey };
	const currentEnvelope = encryptTenantSecret('current-secret-that-is-long-enough', tenantId, keyring);
	assert.match(currentEnvelope, /^v2\.key-2026-07\./);
	assert.deepEqual(inspectTenantSecretEnvelope(currentEnvelope), { version: 'v2', keyId: 'key-2026-07' });
	assert.equal(decryptTenantSecret(currentEnvelope, tenantId, keyring), 'current-secret-that-is-long-enough');
	assert.equal(decryptTenantSecret(legacyEnvelope, tenantId, keyring), 'legacy-secret-that-is-long-enough');
	assert.throws(() => decryptTenantSecret(currentEnvelope.replace('key-2026-07', 'key-2026-08'), tenantId, { ...keyring, keys: new Map([['key-2026-08', currentKey]]) }), /integrity/i);
});

test('validates an explicit active keyring without weakening legacy compatibility', () => {
	const current = randomBytes(32).toString('base64url');
	const legacy = randomBytes(32).toString('base64url');
	const env = { KCEV_SECRETS_ENCRYPTION_KEYS: JSON.stringify({ current }), KCEV_SECRETS_ACTIVE_KEY_ID: 'current', KCEV_SECRETS_ENCRYPTION_KEY: legacy };
	const keyring = secretsEncryptionKeyring(env);
	assert.equal(keyring.activeKeyId, 'current');
	assert.equal(keyring.keys.get('current').length, 32);
	assert.equal(keyring.legacyKey.length, 32);
	assert.equal(secretsEncryptionKeyring({ ...env, KCEV_SECRETS_ACTIVE_KEY_ID: 'missing' }), null);
	assert.equal(secretsEncryptionKeyring({ KCEV_SECRETS_ENCRYPTION_KEYS: '{invalid' }), null);
});
