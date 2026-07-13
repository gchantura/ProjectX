import { createHash } from 'node:crypto';
import { getSupabaseConfig } from '../agent/supabaseStore.server.js';

export function createDistributedRateLimitStore({ config = getSupabaseConfig(), fetchImpl = globalThis.fetch } = {}) {
	if (!config) return null;
	return {
		async status({ signal } = {}) {
			const response = await fetchImpl(`${config.url}/rest/v1/agent_rate_limit_buckets?tenant_id=eq.${encodeURIComponent(config.tenantId)}&select=request_count&limit=1`, { method: 'GET', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]), headers: { apikey: config.key, ...(!config.key.startsWith('sb_secret_') ? { authorization: `Bearer ${config.key}` } : {}), accept: 'application/json' } }).catch((cause) => { throw Object.assign(new Error('Distributed rate limiter is unavailable.'), { status: 503, cause }); });
			if (!response.ok) throw Object.assign(new Error('Distributed rate limiter is unavailable.'), { status: 503 });
			return { backend: 'supabase-postgres', distributed: true };
		},
		async consume(key, limit, { signal } = {}) {
			const response = await fetchImpl(`${config.url}/rest/v1/rpc/consume_agent_rate_limit`, {
				method: 'POST', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
				headers: { apikey: config.key, ...(!config.key.startsWith('sb_secret_') ? { authorization: `Bearer ${config.key}` } : {}), accept: 'application/json', 'content-type': 'application/json' },
				body: JSON.stringify({ p_tenant_id: config.tenantId, p_key_sha256: createHash('sha256').update(String(key)).digest('hex'), p_limit: limit, p_window_seconds: 60 })
			}).catch((cause) => { throw Object.assign(new Error('Distributed rate limiter is unavailable.'), { status: 503, cause }); });
			if (!response.ok) throw Object.assign(new Error('Distributed rate limiter rejected the request.'), { status: 503 });
			return response.json();
		}
	};
}
