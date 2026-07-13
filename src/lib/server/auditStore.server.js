import { getSupabaseConfig } from '../agent/supabaseStore.server.js';

export function createAuditStore({ config = getSupabaseConfig(), fetchImpl = globalThis.fetch } = {}) {
	if (!config) return null;
	return {
		append(event, { signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/append_agent_audit_event', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_event: event } });
		},
		async list({ limit = 200, signal } = {}) {
			const bounded = Math.max(1, Math.min(1000, Number(limit) || 200));
			const rows = await request(fetchImpl, config, `/rest/v1/agent_audit_events?tenant_id=eq.${encodeURIComponent(config.tenantId)}&select=sequence,occurred_at,actor_id,actor_role,action,resource_type,resource_id,outcome,request_id,trace_id,metadata,previous_hash,event_hash&order=sequence.desc&limit=${bounded}`, { method: 'GET', signal });
			return rows.map(fromRow);
		},
		verify({ signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/verify_agent_audit_chain', { method: 'POST', signal, body: { p_tenant_id: config.tenantId } });
		}
	};
}

export async function recordMutationAudit({ store = createAuditStore(), identity, method, pathname, status, requestId, traceId }) {
	if (!store || !identity || ['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'skipped';
	await store.append({
		actorId: String(identity.subject).slice(0, 200), actorRole: identity.role,
		action: `${method} ${auditRoute(pathname)}`.slice(0, 200),
		resourceType: resourceType(pathname), outcome: status < 400 ? 'succeeded' : 'failed',
		requestId, traceId, metadata: { status }
	});
	return 'recorded';
}

export function auditRoute(pathname) {
	return pathname.replace(/run-[a-z0-9-]+/gi, ':runId').replace(/\/api\/admin\/identities\/[^/]+$/i, '/api/admin/identities/:identityId').slice(0, 160);
}

function resourceType(pathname) { return pathname.split('/').filter(Boolean)[1] ?? 'application'; }
function fromRow(row) { return { sequence: row.sequence, occurredAt: row.occurred_at, actorId: row.actor_id, actorRole: row.actor_role, action: row.action, resourceType: row.resource_type, resourceId: row.resource_id, outcome: row.outcome, requestId: row.request_id, traceId: row.trace_id, metadata: row.metadata, previousHash: row.previous_hash, eventHash: row.event_hash }; }

async function request(fetchImpl, config, path, { method, body, signal }) {
	const response = await fetchImpl(`${config.url}${path}`, { method, signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]), headers: { apikey: config.key, ...(!config.key.startsWith('sb_secret_') ? { authorization: `Bearer ${config.key}` } : {}), accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }).catch((cause) => { throw Object.assign(new Error('Unable to reach the security audit ledger.'), { status: 502, cause }); });
	if (!response.ok) throw Object.assign(new Error('Security audit ledger request failed.'), { status: response.status });
	return response.status === 204 ? null : response.json();
}
