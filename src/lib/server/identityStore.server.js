import { createHash } from 'node:crypto';
import { getSupabaseConfig } from '../agent/supabaseStore.server.js';

export function createIdentityStore({ config = getSupabaseConfig(), fetchImpl = globalThis.fetch } = {}) {
	if (!config) return null;
	return {
		boundaryStatus({ signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/verify_agent_tenant_boundary', { method: 'POST', signal, body: { p_tenant_id: config.tenantId } });
		},
		async findByTokenSha256(tokenSha256, { signal } = {}) {
			const rows = await request(fetchImpl, config, `/rest/v1/agent_identities?token_sha256=eq.${encodeURIComponent(tokenSha256)}&status=eq.active&select=tenant_id,id,display_name,role,status,created_at,updated_at,agent_tenants(name,status)&limit=2`, { method: 'GET', signal });
			return rows.length === 1 ? fromRow(rows[0]) : undefined;
		},
		async listMemberships(accountTenantId, identityId, { signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/list_agent_account_memberships', { method: 'POST', signal, body: { p_account_tenant_id: accountTenantId, p_identity_id: identityId } });
		},
		async resolveMembership(accountTenantId, identityId, tenantId, { signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/resolve_agent_organization_membership', { method: 'POST', signal, body: { p_account_tenant_id: accountTenantId, p_identity_id: identityId, p_tenant_id: tenantId } });
		},
		async resolveFederatedMembership(tenantId, identityId, { signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/resolve_agent_federated_membership', { method: 'POST', signal, body: { p_tenant_id: tenantId, p_identity_id: identityId } });
		},
		async listOrganizationMembers({ signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/list_agent_organization_members', { method: 'POST', signal, body: { p_tenant_id: config.tenantId } });
		},
		async upsertMembership(accountTenantId, identityId, role, actor, { signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/upsert_agent_organization_membership', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_account_tenant_id: accountTenantId, p_identity_id: identityId, p_role: role, p_actor: actor } });
		},
		async revokeMembership(accountTenantId, identityId, actor, { signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/revoke_agent_organization_membership', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_account_tenant_id: accountTenantId, p_identity_id: identityId, p_actor: actor } });
		},
		async get(id, { tenantId = config.tenantId, signal } = {}) {
			const rows = await request(fetchImpl, config, `/rest/v1/agent_identities?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(id)}&select=tenant_id,id,display_name,role,status,created_at,updated_at,revoked_at,agent_tenants(name,status)&limit=1`, { method: 'GET', signal });
			return rows[0] ? fromRow(rows[0]) : undefined;
		},
		async tenantStatus(tenantId, { signal } = {}) {
			const rows = await request(fetchImpl, config, `/rest/v1/agent_tenants?id=eq.${encodeURIComponent(tenantId)}&select=id,name,status&limit=1`, { method: 'GET', signal });
			return rows[0] ? { id: rows[0].id, name: rows[0].name, status: rows[0].status } : undefined;
		},
		async list({ signal } = {}) {
			const rows = await request(fetchImpl, config, `/rest/v1/agent_identities?tenant_id=eq.${encodeURIComponent(config.tenantId)}&select=id,display_name,role,status,created_at,updated_at,revoked_at&order=updated_at.desc`, { method: 'GET', signal });
			return rows.map(fromRow);
		},
		async upsert(identity, actor, { signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/upsert_agent_identity', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_identity: identity, p_actor: actor } });
		},
		async revoke(id, actor, { signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/revoke_agent_identity', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_identity_id: id, p_actor: actor } });
		},
		async events(id, { signal } = {}) {
			return request(fetchImpl, config, `/rest/v1/agent_identity_events?tenant_id=eq.${encodeURIComponent(config.tenantId)}&identity_id=eq.${encodeURIComponent(id)}&select=event_type,actor_id,event_at,metadata&order=event_at.desc`, { method: 'GET', signal });
		},
		async recordFederatedLogin(id, issuer, subject, { tenantId = config.tenantId, accountTenantId = tenantId, signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/record_agent_federated_login', { method: 'POST', signal, body: { p_tenant_id: tenantId, p_account_tenant_id: accountTenantId, p_identity_id: id, p_actor: id, p_issuer: issuer, p_subject_sha256: createHash('sha256').update(subject).digest('hex') } });
		}
	};
}

async function request(fetchImpl, config, path, { method, body, signal }) {
	const response = await fetchImpl(`${config.url}${path}`, {
		method,
		signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
		headers: { apikey: config.key, ...(!config.key.startsWith('sb_secret_') ? { authorization: `Bearer ${config.key}` } : {}), accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined
	}).catch((cause) => { throw Object.assign(new Error('Unable to reach the identity directory.'), { status: 502, cause }); });
	if (!response.ok) throw Object.assign(new Error('Identity directory request failed.'), { status: response.status });
	return response.status === 204 ? null : response.json();
}

function fromRow(row) { return { id: row.id, displayName: row.display_name, role: row.role, status: row.status, tenantId: row.tenant_id, accountTenantId: row.tenant_id, tenantName: row.agent_tenants?.name ?? `Organization ${String(row.tenant_id ?? '').slice(0, 8)}`, tenantStatus: row.agent_tenants?.status, createdAt: row.created_at, updatedAt: row.updated_at, revokedAt: row.revoked_at ?? null }; }
