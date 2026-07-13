import { getSupabaseConfig } from '../agent/supabaseStore.server.js';

export function createOrganizationStore({ config = getSupabaseConfig(), fetchImpl = globalThis.fetch } = {}) {
	if (!config) return null;
	return {
		async get(id, { signal } = {}) {
			const rows = await request(fetchImpl, config, `/rest/v1/agent_tenants?id=eq.${encodeURIComponent(id)}&select=id,name,slug,status,created_at,updated_at&limit=1`, { method: 'GET', signal });
			return rows[0] ? fromRow(rows[0]) : undefined;
		},
		async findBySlug(slug, { signal } = {}) {
			const rows = await request(fetchImpl, config, `/rest/v1/agent_tenants?slug=eq.${encodeURIComponent(slug)}&select=id,name,slug,status,created_at,updated_at&limit=1`, { method: 'GET', signal });
			return rows[0] ? fromRow(rows[0]) : undefined;
		},
		async list({ signal } = {}) {
			const rows = await request(fetchImpl, config, '/rest/v1/agent_tenants?select=id,name,slug,status,created_at,updated_at&order=created_at.desc', { method: 'GET', signal });
			return rows.map(fromRow);
		},
		provision({ name, slug, admin }, actor, { signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/provision_agent_tenant', {
				method: 'POST',
				signal,
				body: { p_name: name, p_slug: slug, p_admin: admin, p_actor: actor }
			});
		},
		updateStatus(id, status, actor, { signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/set_agent_tenant_status', { method: 'POST', signal, body: { p_tenant_id: id, p_status: status, p_actor: actor } });
		}
	};
}

async function request(fetchImpl, config, path, { method, body, signal }) {
	const response = await fetchImpl(`${config.url}${path}`, {
		method,
		signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
		headers: { apikey: config.key, ...(!config.key.startsWith('sb_secret_') ? { authorization: `Bearer ${config.key}` } : {}), accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined
	}).catch((cause) => { throw Object.assign(new Error('Unable to reach the organization directory.'), { status: 502, cause }); });
	if (!response.ok) throw Object.assign(new Error(response.status === 409 ? 'The organization slug or administrator credential already exists.' : 'Organization directory request failed.'), { status: response.status });
	return response.status === 204 ? null : response.json();
}

function fromRow(row) { return { id: row.id, name: row.name, slug: row.slug, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }; }
