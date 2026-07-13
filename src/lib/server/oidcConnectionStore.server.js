import { getSupabaseConfig } from '../agent/supabaseStore.server.js';
import { oidcConfig, oidcConfigFromValues } from './oidc.server.js';
import { decryptTenantSecret, encryptTenantSecret, inspectTenantSecretEnvelope, secretsEncryptionKeyring } from './secretEnvelope.js';

export function createOidcConnectionStore({ config = getSupabaseConfig(), encryptionKey, encryptionKeyring = secretsEncryptionKeyring(), fetchImpl = globalThis.fetch } = {}) {
	const keyring = encryptionKey ? { activeKeyId: 'legacy', keys: new Map([['legacy', encryptionKey]]), legacyKey: encryptionKey } : encryptionKeyring;
	if (!config || !keyring) return null;
	return {
		activeKeyId: keyring.activeKeyId,
		async get(tenantId, { includeSecret = false, signal } = {}) {
			const secretColumn = includeSecret ? ',client_secret_ciphertext' : '';
			const rows = await request(fetchImpl, config, `/rest/v1/agent_oidc_connections?tenant_id=eq.${encodeURIComponent(tenantId)}&select=tenant_id,display_name,issuer,client_id,scopes,allowed_endpoint_origins,status,revision,encryption_key_id,created_at,updated_at${secretColumn}&limit=1`, { method: 'GET', signal });
			return rows[0] ? fromRow(rows[0], includeSecret ? decryptTenantSecret(rows[0].client_secret_ciphertext, tenantId, keyring) : undefined) : undefined;
		},
		async upsert(tenantId, connection, actor, { signal } = {}) {
			const encrypted = encryptTenantSecret(connection.clientSecret, tenantId, keyring);
			return request(fetchImpl, config, '/rest/v1/rpc/upsert_agent_oidc_connection', { method: 'POST', signal, body: { p_tenant_id: tenantId, p_connection: { displayName: connection.displayName, issuer: connection.issuer, clientId: connection.clientId, clientSecretCiphertext: encrypted, encryptionKeyId: keyring.activeKeyId, scopes: connection.scopes, allowedEndpointOrigins: connection.allowedEndpointOrigins }, p_actor: actor } });
		},
		setStatus(tenantId, status, actor, { signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/set_agent_oidc_connection_status', { method: 'POST', signal, body: { p_tenant_id: tenantId, p_status: status, p_actor: actor } });
		},
		async rotationInventory({ signal } = {}) {
			const records = [];
			for await (const page of rotationInventoryPages({ signal })) records.push(...page);
			return records;
		},
		rotationInventoryPages,
		async keyRotationStatus({ signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/get_agent_oidc_key_rotation_status', { method: 'POST', signal, body: { p_active_key_id: keyring.activeKeyId } });
		},
		async reencrypt(record, actor, { signal } = {}) {
			const plaintext = decryptTenantSecret(record.ciphertext, record.tenantId, keyring);
			const ciphertext = encryptTenantSecret(plaintext, record.tenantId, keyring);
			return request(fetchImpl, config, '/rest/v1/rpc/reencrypt_agent_oidc_connection', { method: 'POST', signal, body: { p_tenant_id: record.tenantId, p_expected_revision: record.revision, p_ciphertext: ciphertext, p_encryption_key_id: keyring.activeKeyId, p_actor: actor } });
		}
	};

	async function* rotationInventoryPages({ signal, pageSize = 250 } = {}) {
		const limit = Number.isInteger(pageSize) ? Math.max(1, Math.min(pageSize, 500)) : 250;
		let cursor = '';
		while (true) {
			const after = cursor ? `&tenant_id=gt.${encodeURIComponent(cursor)}` : '';
			const rows = await request(fetchImpl, config, `/rest/v1/agent_oidc_connections?select=tenant_id,revision,encryption_key_id,client_secret_ciphertext&order=tenant_id.asc${after}&limit=${limit}`, { method: 'GET', signal });
			yield rows.map((row) => ({ tenantId: row.tenant_id, revision: row.revision, encryptionKeyId: row.encryption_key_id ?? inspectTenantSecretEnvelope(row.client_secret_ciphertext).keyId, ciphertext: row.client_secret_ciphertext }));
			if (rows.length < limit) break;
			cursor = rows.at(-1).tenant_id;
		}
	}
}

export async function resolveTenantOidcConfig(tenantId, { store = createOidcConnectionStore(), env = process.env } = {}) {
	if (store) {
		const connection = await store.get(tenantId, { includeSecret: true });
		if (connection) {
			if (connection.status !== 'active') return null;
			return oidcConfigFromValues({ ...connection, source: 'tenant', revision: connection.revision });
		}
	}
	const configuredTenantId = getSupabaseConfig(env)?.tenantId ?? String(env.SUPABASE_TENANT_ID ?? '');
	if (configuredTenantId && configuredTenantId !== tenantId) return null;
	return oidcConfig(env);
}

async function request(fetchImpl, config, path, { method, body, signal, headers = {} }) {
	const response = await fetchImpl(`${config.url}${path}`, {
		method,
		signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
		headers: { apikey: config.key, ...(!config.key.startsWith('sb_secret_') ? { authorization: `Bearer ${config.key}` } : {}), accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
		body: body ? JSON.stringify(body) : undefined
	}).catch((cause) => { throw Object.assign(new Error('Unable to reach the OIDC connection directory.'), { status: 502, cause }); });
	if (!response.ok) {
		const failure = await response.json().catch(() => ({}));
		const code = /^[A-Za-z0-9_]{2,40}$/.test(String(failure?.code ?? '')) ? String(failure.code) : 'OIDC_DIRECTORY_FAILED';
		throw Object.assign(new Error('OIDC connection directory request failed.'), { status: response.status, code });
	}
	return response.status === 204 ? null : response.json();
}

function fromRow(row, clientSecret) { return { tenantId: row.tenant_id, displayName: row.display_name, issuer: row.issuer, clientId: row.client_id, ...(clientSecret ? { clientSecret } : {}), scopes: row.scopes, allowedEndpointOrigins: Array.isArray(row.allowed_endpoint_origins) ? row.allowed_endpoint_origins : [], status: row.status, revision: row.revision, encryptionKeyId: row.encryption_key_id, createdAt: row.created_at, updatedAt: row.updated_at, secretConfigured: true }; }
