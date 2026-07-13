import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export function secretsEncryptionKey(env = process.env) {
	return decodeKey(env.KCEV_SECRETS_ENCRYPTION_KEY);
}

export function secretsEncryptionKeyring(env = process.env) {
	let configured = {};
	try { configured = JSON.parse(env.KCEV_SECRETS_ENCRYPTION_KEYS ?? '{}'); }
	catch { return null; }
	if (!configured || Array.isArray(configured) || typeof configured !== 'object') return null;

	const keys = new Map();
	for (const [keyId, encoded] of Object.entries(configured)) {
		const key = decodeKey(encoded);
		if (!KEY_ID_PATTERN.test(keyId) || !key) return null;
		keys.set(keyId, key);
	}
	const legacyKey = secretsEncryptionKey(env);
	const activeKeyId = String(env.KCEV_SECRETS_ACTIVE_KEY_ID ?? '');
	if (keys.size === 0) return legacyKey ? { activeKeyId: 'legacy', keys: new Map([['legacy', legacyKey]]), legacyKey } : null;
	if (!KEY_ID_PATTERN.test(activeKeyId) || !keys.has(activeKeyId)) return null;
	return { activeKeyId, keys, legacyKey };
}

export function encryptTenantSecret(value, tenantId, keySource) {
	const keyring = normalizeKeySource(keySource);
	const key = keyring?.keys.get(keyring.activeKeyId);
	if (!key || typeof value !== 'string' || value.length < 16 || value.length > 2048) throw new Error('A valid encryption key and 16-2048 character secret are required.');
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(aad(tenantId, keyring.version === 'v2' ? keyring.activeKeyId : undefined));
	const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	const payload = `${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
	return keyring.version === 'v2' ? `v2.${keyring.activeKeyId}.${payload}` : `v1.${payload}`;
}

export function decryptTenantSecret(envelope, tenantId, keySource) {
	try {
		const keyring = normalizeKeySource(keySource);
		if (!keyring) throw new Error();
		const parsed = parseEnvelope(envelope);
		const key = parsed.version === 'v2' ? keyring.keys.get(parsed.keyId) : keyring.legacyKey;
		if (!key) throw new Error();
		const { iv, ciphertext, tag } = parsed;
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
		decipher.setAAD(aad(tenantId, parsed.keyId));
		decipher.setAuthTag(Buffer.from(tag, 'base64url'));
		return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
	} catch {
		throw Object.assign(new Error('Encrypted secret integrity validation failed.'), { code: 'SECRET_INTEGRITY_FAILED' });
	}
}

export function inspectTenantSecretEnvelope(envelope) {
	const parsed = parseEnvelope(envelope);
	return { version: parsed.version, keyId: parsed.keyId ?? 'legacy' };
}

function normalizeKeySource(value) {
	if (Buffer.isBuffer(value) && value.length === 32) return { activeKeyId: 'legacy', keys: new Map([['legacy', value]]), legacyKey: value, version: 'v1' };
	if (!value || !KEY_ID_PATTERN.test(value.activeKeyId) || !(value.keys instanceof Map) || !value.keys.has(value.activeKeyId)) return null;
	return { ...value, version: 'v2' };
}

function parseEnvelope(envelope) {
	const parts = String(envelope ?? '').split('.');
	if (parts[0] === 'v1' && parts.length === 4 && parts.slice(1).every(Boolean)) return { version: 'v1', keyId: undefined, iv: parts[1], ciphertext: parts[2], tag: parts[3] };
	if (parts[0] === 'v2' && parts.length === 5 && KEY_ID_PATTERN.test(parts[1]) && parts.slice(2).every(Boolean)) return { version: 'v2', keyId: parts[1], iv: parts[2], ciphertext: parts[3], tag: parts[4] };
	throw new Error('Invalid secret envelope.');
}

function decodeKey(encoded) {
	if (!/^[A-Za-z0-9_-]{43}$/.test(String(encoded ?? ''))) return null;
	const key = Buffer.from(String(encoded), 'base64url');
	return key.length === 32 ? key : null;
}

function aad(tenantId, keyId) {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(tenantId ?? ''))) throw new Error('A valid tenant ID is required.');
	return Buffer.from(`kcevagent:oidc-client-secret:${tenantId}${keyId ? `:${keyId}` : ''}`, 'utf8');
}
