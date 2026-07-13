import { createHash } from 'node:crypto';
import { getSupabaseConfig } from '../agent/supabaseStore.server.js';

export function createIdentityLifecycleStore({ config = getSupabaseConfig(), fetchImpl = globalThis.fetch } = {}) {
	if (!config) return null;
	return {
		listInvitations({ signal } = {}) {
			return rpc(fetchImpl, config, 'list_agent_identity_invitations', { p_tenant_id: config.tenantId }, signal);
		},
		createInvitation({ email, role, expiresAt }, actor, { signal } = {}) {
			return rpc(fetchImpl, config, 'create_agent_identity_invitation', { p_tenant_id: config.tenantId, p_email: email, p_role: role, p_expires_at: expiresAt, p_actor: actor }, signal);
		},
		revokeInvitation(id, actor, { signal } = {}) {
			return rpc(fetchImpl, config, 'revoke_agent_identity_invitation', { p_tenant_id: config.tenantId, p_invitation_id: id, p_actor: actor }, signal);
		},
		redeemOidcInvitation(tenantId, { email, displayName, issuer, subject }, { signal } = {}) {
			return rpc(fetchImpl, config, 'redeem_agent_oidc_invitation', {
				p_tenant_id: tenantId,
				p_email: email,
				p_display_name: displayName,
				p_issuer: issuer,
				p_subject_sha256: sha256(subject)
			}, signal);
		},
		async getScimConnection({ signal } = {}) {
			const rows = await request(fetchImpl, config, `/rest/v1/agent_scim_connections?tenant_id=eq.${encodeURIComponent(config.tenantId)}&select=id,tenant_id,display_name,status,created_at,updated_at,last_used_at&limit=1`, { method: 'GET', signal });
			return rows[0] ? fromConnection(rows[0]) : undefined;
		},
		configureScim(displayName, token, actor, { signal } = {}) {
			return rpc(fetchImpl, config, 'upsert_agent_scim_connection', { p_tenant_id: config.tenantId, p_display_name: displayName, p_token_sha256: sha256(token), p_actor: actor }, signal);
		},
		setScimStatus(status, actor, { signal } = {}) {
			return rpc(fetchImpl, config, 'set_agent_scim_connection_status', { p_tenant_id: config.tenantId, p_status: status, p_actor: actor }, signal);
		},
		authenticateScimToken(token, { signal } = {}) {
			return rpc(fetchImpl, config, 'authenticate_agent_scim_token', { p_token_sha256: sha256(token) }, signal);
		},
		listScimUsers({ userName = '', offset = 0, limit = 100, signal } = {}) {
			return rpc(fetchImpl, config, 'list_agent_scim_users', { p_tenant_id: config.tenantId, p_user_name: userName, p_offset: offset, p_limit: limit }, signal);
		},
		countScimUsers(userName = '', { signal } = {}) {
			return rpc(fetchImpl, config, 'count_agent_scim_users', { p_tenant_id: config.tenantId, p_user_name: userName }, signal);
		},
		getScimUser(id, { signal } = {}) {
			return rpc(fetchImpl, config, 'get_agent_scim_user', { p_tenant_id: config.tenantId, p_resource_id: id }, signal);
		},
		upsertScimUser(id, user, actor, { signal } = {}) {
			return rpc(fetchImpl, config, 'upsert_agent_scim_user', { p_tenant_id: config.tenantId, p_resource_id: id || null, p_user: user, p_actor: actor }, signal);
		},
		deprovisionScimUser(id, actor, { signal } = {}) {
			return rpc(fetchImpl, config, 'deprovision_agent_scim_user', { p_tenant_id: config.tenantId, p_resource_id: id, p_actor: actor }, signal);
		}
	};
}

export function createTenantIdentityLifecycleStore(tenantId, options = {}) {
	const config = options.config ?? getSupabaseConfig();
	return createIdentityLifecycleStore({ ...options, config: config ? { ...config, tenantId } : null });
}

export async function authenticateScimCredential(token, { store = createIdentityLifecycleStore() } = {}) {
	if (typeof token !== 'string' || token.length < 32) return { authenticated: false, status: 401, reason: 'A valid SCIM bearer token is required.' };
	if (!store) return { authenticated: false, status: 503, reason: 'SCIM provisioning is not configured.' };
	try {
		const identity = await store.authenticateScimToken(token);
		return identity ? { authenticated: true, method: 'scim', platformAdmin: false, ...identity } : { authenticated: false, status: 401, reason: 'The SCIM bearer token is invalid or disabled.' };
	} catch {
		return { authenticated: false, status: 503, reason: 'SCIM authentication is temporarily unavailable.' };
	}
}

async function rpc(fetchImpl, config, name, body, signal) {
	return request(fetchImpl, config, `/rest/v1/rpc/${name}`, { method: 'POST', body, signal });
}

async function request(fetchImpl, config, path, { method, body, signal }) {
	const response = await fetchImpl(`${config.url}${path}`, {
		method,
		signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
		headers: { apikey: config.key, ...(!config.key.startsWith('sb_secret_') ? { authorization: `Bearer ${config.key}` } : {}), accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined
	}).catch((cause) => { throw Object.assign(new Error('Unable to reach the identity lifecycle directory.'), { status: 502, cause }); });
	if (!response.ok) {
		const failure = await response.json().catch(() => ({}));
		const conflict = failure?.code === '23505';
		throw Object.assign(new Error(conflict ? 'Identity lifecycle resource already exists.' : 'Identity lifecycle directory request failed.'), { status: conflict ? 409 : response.status });
	}
	return response.status === 204 ? null : response.json();
}

function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function fromConnection(row) { return { id: row.id, tenantId: row.tenant_id, displayName: row.display_name, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at }; }
