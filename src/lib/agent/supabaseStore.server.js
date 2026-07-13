import { randomUUID } from 'node:crypto';
import { currentTenantContext } from '../server/tenantContext.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEST_STATE = Symbol.for('kcevagent.supabase-test-state');

export function isSupabaseTestMode(env = process.env) {
	return env.NODE_ENV === 'test' && env.KCEV_SUPABASE_TEST_MODE === 'true' && !getSupabaseConfig(env);
}

export function clearSupabaseTestState() {
	if (!isSupabaseTestMode()) throw new Error('Supabase test state is unavailable outside explicit test mode.');
	globalThis[TEST_STATE] = createTestState();
}

export function getSupabaseConfig(env = process.env) {
	const url = String(env.SUPABASE_URL ?? '').replace(/\/$/, '');
	const key = String(env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '');
	const requestTenantId = currentTenantContext()?.id;
	const tenantId = UUID.test(String(requestTenantId ?? '')) ? String(requestTenantId) : String(env.SUPABASE_TENANT_ID ?? '');
	if (!url || !key || !UUID.test(tenantId)) return null;
	let parsed;
	try { parsed = new URL(url); } catch { return null; }
	if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) return null;
	return { url, key, tenantId };
}

export function createSupabaseProjectStore(options = {}) {
	if (!options.config && isSupabaseTestMode(options.env ?? process.env)) return createTestProjectStore();
	const config = options.config ?? getSupabaseConfig(options.env);
	if (!config) throw Object.assign(new Error('Supabase projects require SUPABASE_URL, a server secret key, and a UUID SUPABASE_TENANT_ID.'), { status: 503 });
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	return {
		async list({ signal } = {}) {
			const rows = await request(fetchImpl, config, `/rest/v1/agent_projects?tenant_id=eq.${encodeURIComponent(config.tenantId)}&select=id,name,kind,status,metadata,created_at,updated_at&order=updated_at.desc`, { method: 'GET', signal });
			return rows.map(rowToProject);
		},
		async get(id, { signal } = {}) {
			const rows = await request(fetchImpl, config, `/rest/v1/agent_projects?tenant_id=eq.${encodeURIComponent(config.tenantId)}&id=eq.${encodeURIComponent(id)}&select=id,name,kind,status,metadata,created_at,updated_at&limit=1`, { method: 'GET', signal });
			return rows[0] ? rowToProject(rows[0]) : undefined;
		},
		async create(project, { signal } = {}) {
			const body = {
				tenant_id: config.tenantId,
				id: project.id,
				name: project.name,
				kind: project.kind,
				status: project.status,
				metadata: { workspaceRoot: project.workspaceRoot }
			};
			const rows = await request(fetchImpl, config, '/rest/v1/agent_projects', { method: 'POST', signal, body, prefer: 'return=representation' });
			return rowToProject(rows[0]);
		},
		async saveSettings(id, settings, { signal } = {}) {
			const current = await this.get(id, { signal });
			if (!current) throw Object.assign(new Error('The selected project does not exist in Supabase.'), { status: 404 });
			const metadata = { ...(current.metadata ?? {}), workspaceRoot: current.workspaceRoot, settings };
			const rows = await request(fetchImpl, config, `/rest/v1/agent_projects?tenant_id=eq.${encodeURIComponent(config.tenantId)}&id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', signal, body: { metadata, updated_at: new Date().toISOString() }, prefer: 'return=representation' });
			return rowToProject(rows[0]);
		}
	};
}

export function createSupabaseRunStore(options = {}) {
	if (!options.config && isSupabaseTestMode(options.env ?? process.env)) return createTestRunStore();
	const config = options.config ?? getSupabaseConfig(options.env);
	if (!config) throw Object.assign(new Error('Supabase storage requires SUPABASE_URL, a server secret key, and a UUID SUPABASE_TENANT_ID.'), { status: 503 });
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	return {
		async persist(run, { signal } = {}) {
			const project = { id: run.config?.projectId, name: run.config?.projectName, kind: 'repository' };
			if (!/^project-[a-z0-9-]+$/i.test(String(project.id ?? ''))) throw Object.assign(new Error('Supabase run persistence requires a registered project id.'), { status: 400 });
			await request(fetchImpl, config, '/rest/v1/rpc/persist_agent_project', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_project: project } });
			await request(fetchImpl, config, '/rest/v1/rpc/persist_agent_run', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_run: run } });
			if (run.endedAt) {
				await request(fetchImpl, config, `/rest/v1/agent_runs?tenant_id=eq.${encodeURIComponent(config.tenantId)}&project_id=eq.${encodeURIComponent(project.id)}&id=eq.${encodeURIComponent(run.id)}`, {
					method: 'PATCH',
					signal,
					body: { completed_at: run.endedAt, updated_at: run.endedAt }
				});
			}
			return run;
		},
		async get(id, { projectId, signal } = {}) {
			const projectFilter = projectId ? `&project_id=eq.${encodeURIComponent(projectId)}` : '';
			const rows = await request(fetchImpl, config, `/rest/v1/agent_runs?tenant_id=eq.${encodeURIComponent(config.tenantId)}${projectFilter}&id=eq.${encodeURIComponent(id)}&select=run_json&limit=1`, { method: 'GET', signal });
			return rows[0]?.run_json;
		},
		async list({ projectId, limit = 20, signal } = {}) {
			const bounded = Math.min(Math.max(Math.trunc(Number(limit) || 20), 1), 100);
			const projectFilter = projectId ? `&project_id=eq.${encodeURIComponent(projectId)}` : '';
			const rows = await request(fetchImpl, config, `/rest/v1/agent_runs?tenant_id=eq.${encodeURIComponent(config.tenantId)}${projectFilter}&select=run_json&order=started_at.desc&limit=${bounded}`, { method: 'GET', signal });
			return rows.map((row) => row.run_json);
		},
		async persistEvents(runId, events = [], { projectId, signal } = {}) {
			if (!/^project-[a-z0-9-]+$/i.test(String(projectId ?? ''))) throw Object.assign(new Error('Supabase event persistence requires a valid project id.'), { status: 400 });
			const rows = events.map((event) => ({
				tenant_id: config.tenantId,
				project_id: projectId,
				run_id: runId,
				position: event.position,
				event_type: event.type,
				payload: event.payload,
				created_at: event.createdAt
			}));
			if (rows.length === 0) return [];
			await request(fetchImpl, config, '/rest/v1/agent_run_events?on_conflict=tenant_id,run_id,position', { method: 'POST', signal, body: rows, prefer: 'resolution=merge-duplicates' });
			return events;
		},
		async listEvents(runId, { projectId, signal } = {}) {
			const projectFilter = projectId ? `&project_id=eq.${encodeURIComponent(projectId)}` : '';
			const rows = await request(fetchImpl, config, `/rest/v1/agent_run_events?tenant_id=eq.${encodeURIComponent(config.tenantId)}${projectFilter}&run_id=eq.${encodeURIComponent(runId)}&select=position,event_type,payload,created_at&order=position.asc`, { method: 'GET', signal });
			return rows.map((row) => ({ position: Number(row.position), type: row.event_type, payload: row.payload, createdAt: row.created_at }));
		}
	};
}

export function createSupabaseLeaseStore(options = {}) {
	if (!options.config && isSupabaseTestMode(options.env ?? process.env)) return createTestLeaseStore();
	const config = options.config ?? getSupabaseConfig(options.env);
	if (!config) throw Object.assign(new Error('Supabase run leases require server storage configuration.'), { status: 503 });
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	return {
		async status({ now = new Date(), signal } = {}) {
			const rows = await request(fetchImpl, config, `/rest/v1/agent_run_leases?tenant_id=eq.${encodeURIComponent(config.tenantId)}&expires_at=gt.${encodeURIComponent(now.toISOString())}&select=run_id`, { method: 'GET', signal });
			return { activeLeases: rows.length };
		},
		claim({ projectId, runId, ownerId, ttlSeconds = 300, signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/claim_agent_run_lease', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_project_id: projectId, p_run_id: runId, p_owner_id: ownerId, p_ttl_seconds: ttlSeconds } });
		},
		heartbeat({ runId, leaseToken, ttlSeconds = 300, signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/heartbeat_agent_run_lease', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_run_id: runId, p_lease_token: leaseToken, p_ttl_seconds: ttlSeconds } });
		},
		release({ runId, leaseToken, signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/release_agent_run_lease', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_run_id: runId, p_lease_token: leaseToken } });
		}
	};
}

export function createSupabaseApprovalStore(options = {}) {
	if (!options.config && isSupabaseTestMode(options.env ?? process.env)) return createTestApprovalStore();
	const config = options.config ?? getSupabaseConfig(options.env);
	if (!config) throw Object.assign(new Error('Supabase approvals require server storage configuration.'), { status: 503 });
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	return {
		async status({ now = new Date(), signal } = {}) {
			const rows = await request(fetchImpl, config, `/rest/v1/agent_run_approvals?tenant_id=eq.${encodeURIComponent(config.tenantId)}&decision=eq.pending&expires_at=gt.${encodeURIComponent(now.toISOString())}&select=id`, { method: 'GET', signal });
			return { pendingApprovals: rows.length };
		},
		request({ projectId, runId, planSha256, tokenSha256, actor, expiresAt, signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/request_agent_run_approval', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_project_id: projectId, p_run_id: runId, p_plan_sha256: planSha256, p_token_sha256: tokenSha256, p_actor: actor, p_expires_at: expiresAt } });
		},
		consume({ projectId, runId, planSha256, tokenSha256, actor, signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/consume_agent_run_approval', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_project_id: projectId, p_run_id: runId, p_plan_sha256: planSha256, p_token_sha256: tokenSha256, p_actor: actor } });
		},
		reject({ projectId, runId, actor, signal } = {}) {
			return request(fetchImpl, config, '/rest/v1/rpc/reject_agent_run_approval', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_project_id: projectId, p_run_id: runId, p_actor: actor } });
		},
		async listForRun(runId, { projectId, signal } = {}) {
			const rows = await request(fetchImpl, config, `/rest/v1/agent_run_approvals?tenant_id=eq.${encodeURIComponent(config.tenantId)}&project_id=eq.${encodeURIComponent(projectId)}&run_id=eq.${encodeURIComponent(runId)}&select=id,run_id,plan_sha256,decision,requested_by,decided_by,requested_at,decided_at,expires_at`, { method: 'GET', signal });
			return rows.map(rowToApproval);
		}
	};
}

export function createSupabaseMemoryStore(options = {}) {
	if (!options.config && isSupabaseTestMode(options.env ?? process.env)) return createTestMemoryStore();
	const config = options.config ?? getSupabaseConfig(options.env);
	if (!config) throw Object.assign(new Error('Supabase memory requires SUPABASE_URL, a server secret key, and a UUID SUPABASE_TENANT_ID.'), { status: 503 });
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	return {
		async remember(memory, { signal } = {}) {
			if (!/^project-[a-z0-9-]+$/i.test(String(memory.projectId ?? ''))) throw Object.assign(new Error('Supabase memory persistence requires a registered project id.'), { status: 400 });
			await request(fetchImpl, config, '/rest/v1/rpc/persist_agent_project', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_project: { id: memory.projectId, name: memory.projectName ?? memory.projectId, kind: 'repository' } } });
			const stored = await request(fetchImpl, config, '/rest/v1/rpc/persist_agent_memory', { method: 'POST', signal, body: { p_tenant_id: config.tenantId, p_memory: memory } });
			return stored ?? memory;
		},
		async list({ projectId, scope = projectId ?? 'workspace', limit = 200, now = new Date(), signal } = {}) {
			const bounded = Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), 500);
			const projectFilter = projectId ? `&project_id=eq.${encodeURIComponent(projectId)}` : '';
			const path = `/rest/v1/agent_memories?tenant_id=eq.${encodeURIComponent(config.tenantId)}${projectFilter}&scope=eq.${encodeURIComponent(scope)}&select=memory_json,expires_at&order=importance.desc,updated_at.desc&limit=${bounded}`;
			const rows = await request(fetchImpl, config, path, { method: 'GET', signal });
			const cutoff = now.toISOString();
			return rows
				.filter((row) => !row.expires_at || row.expires_at > cutoff)
				.map((row) => row.memory_json);
		},
		async forget(id, { projectId, scope = projectId ?? 'workspace', signal } = {}) {
			const projectFilter = projectId ? `&project_id=eq.${encodeURIComponent(projectId)}` : '';
			const rows = await request(fetchImpl, config, `/rest/v1/agent_memories?tenant_id=eq.${encodeURIComponent(config.tenantId)}${projectFilter}&id=eq.${encodeURIComponent(id)}&scope=eq.${encodeURIComponent(scope)}`, { method: 'DELETE', signal });
			return Array.isArray(rows) ? rows.length > 0 : true;
		}
	};
}

async function request(fetchImpl, config, path, { method, body, signal, prefer }) {
	const timeout = AbortSignal.timeout(20_000);
	const response = await fetchImpl(`${config.url}${path}`, {
		method, signal: AbortSignal.any([timeout, ...(signal ? [signal] : [])]),
		headers: { apikey: config.key, ...(!config.key.startsWith('sb_secret_') ? { authorization: `Bearer ${config.key}` } : {}), 'user-agent': 'kcevagent-server/1.0', accept: 'application/json', ...(method === 'DELETE' ? { prefer: 'return=representation' } : {}), ...(prefer ? { prefer } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined
	}).catch((cause) => { throw Object.assign(new Error('Unable to reach Supabase storage.'), { status: 502, cause }); });
	if (!response.ok) {
		const payload = await response.json().catch(() => ({}));
		throw Object.assign(new Error(String(payload?.message ?? payload?.error ?? `Supabase storage failed with status ${response.status}.`).slice(0, 240)), { status: response.status });
	}
	if (response.status === 204 || response.headers.get('content-length') === '0') return null;
	return response.json().catch(() => null);
}

function rowToProject(row) {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		status: row.status,
		workspaceRoot: row.metadata?.workspaceRoot ?? null,
		metadata: row.metadata ?? {},
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function testState() {
	globalThis[TEST_STATE] ??= createTestState();
	return globalThis[TEST_STATE];
}

function createTestState() {
	return { projects: new Map(), runs: new Map(), events: new Map(), memories: new Map(), leases: new Map(), approvals: new Map() };
}

function createTestProjectStore() {
	return {
		async list() { return [...testState().projects.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); },
		async get(id) { return testState().projects.get(id); },
		async create(project) {
			const now = new Date().toISOString();
			const stored = { ...project, metadata: { workspaceRoot: project.workspaceRoot }, createdAt: project.createdAt ?? now, updatedAt: now };
			testState().projects.set(project.id, stored);
			return structuredClone(stored);
		},
		async saveSettings(id, settings) {
			const current = testState().projects.get(id) ?? { id, name: id, kind: 'local', status: 'ready', workspaceRoot: process.cwd(), metadata: {}, createdAt: new Date().toISOString() };
			const stored = { ...current, metadata: { ...(current.metadata ?? {}), workspaceRoot: current.workspaceRoot, settings }, updatedAt: new Date().toISOString() };
			testState().projects.set(id, stored);
			return structuredClone(stored);
		}
	};
}

function createTestRunStore() {
	return {
		async persist(run) { testState().runs.set(run.id, structuredClone(run)); return run; },
		async get(id, { projectId } = {}) { const run = testState().runs.get(id); return run && (!projectId || run.config?.projectId === projectId) ? structuredClone(run) : undefined; },
		async list({ projectId, limit = 20 } = {}) { return [...testState().runs.values()].filter((run) => !projectId || run.config?.projectId === projectId).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit).map((run) => structuredClone(run)); },
		async persistEvents(runId, events) { const current = testState().events.get(runId) ?? []; const byPosition = new Map(current.map((event) => [event.position, event])); for (const event of events) byPosition.set(event.position, structuredClone(event)); testState().events.set(runId, [...byPosition.values()].sort((a, b) => a.position - b.position)); return events; },
		async listEvents(runId) { return structuredClone(testState().events.get(runId) ?? []); }
	};
}

function createTestMemoryStore() {
	return {
		async remember(memory) {
			const existing = memory.sourceRunId ? [...testState().memories.values()].find((item) => item.sourceRunId === memory.sourceRunId && item.projectId === memory.projectId) : undefined;
			if (existing) return structuredClone(existing);
			const stored = { ...memory, updatedAt: memory.updatedAt ?? memory.createdAt };
			testState().memories.set(memory.id, stored);
			return structuredClone(stored);
		},
		async list({ projectId, scope = projectId ?? 'workspace', limit = 200, now = new Date() } = {}) { return [...testState().memories.values()].filter((item) => projectId ? item.projectId === projectId : item.projectId == null && item.scope === scope).filter((item) => !item.expiresAt || item.expiresAt > now.toISOString()).sort((a, b) => b.importance - a.importance || String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit).map((item) => structuredClone(item)); },
		async forget(id, { projectId, scope = projectId ?? 'workspace' } = {}) { const item = testState().memories.get(id); if (!item || (projectId ? item.projectId !== projectId : item.projectId != null || item.scope !== scope)) return false; return testState().memories.delete(id); }
	};
}

function createTestLeaseStore() {
	return {
		async status({ now = new Date() } = {}) {
			return { activeLeases: [...testState().leases.values()].filter((lease) => lease.expiresAt > now.toISOString()).length };
		},
		async claim({ projectId, runId, ownerId, ttlSeconds = 300, now = new Date() }) {
			const current = testState().leases.get(runId);
			if (current && current.expiresAt > now.toISOString()) return { acquired: false, runId, ownerId: current.ownerId, expiresAt: current.expiresAt, attempt: current.attempt };
			const attempt = (current?.attempt ?? 0) + 1;
			const lease = { acquired: true, projectId, runId, leaseToken: randomUUID(), ownerId, expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(), attempt };
			testState().leases.set(runId, lease);
			return structuredClone(lease);
		},
		async heartbeat({ runId, leaseToken, ttlSeconds = 300, now = new Date() }) {
			const current = testState().leases.get(runId);
			if (!current || current.leaseToken !== leaseToken || current.expiresAt <= now.toISOString()) return { renewed: false, runId };
			current.expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
			return { renewed: true, runId, expiresAt: current.expiresAt, attempt: current.attempt };
		},
		async release({ runId, leaseToken }) {
			const current = testState().leases.get(runId);
			if (!current || current.leaseToken !== leaseToken) return false;
			return testState().leases.delete(runId);
		}
	};
}

function createTestApprovalStore() {
	return {
		async status({ now = new Date() } = {}) {
			return { pendingApprovals: [...testState().approvals.values()].filter((approval) => approval.decision === 'pending' && approval.expiresAt > now.toISOString()).length };
		},
		async request({ projectId, runId, planSha256, tokenSha256, actor, expiresAt, now = new Date() }) {
			const current = testState().approvals.get(runId);
			if (current && !['pending', 'expired'].includes(current.decision)) throw Object.assign(new Error('Run approval is already finalized.'), { status: 409 });
			const approval = { id: current?.id ?? randomUUID(), projectId, runId, planSha256, tokenSha256, decision: 'pending', requestedBy: actor, requestedAt: now.toISOString(), decidedBy: null, decidedAt: null, expiresAt };
			testState().approvals.set(runId, approval);
			return structuredClone(approval);
		},
		async consume({ projectId, runId, planSha256, tokenSha256, actor, now = new Date() }) {
			const approval = testState().approvals.get(runId);
			if (!approval || approval.projectId !== projectId || approval.planSha256 !== planSha256 || approval.tokenSha256 !== tokenSha256 || approval.decision !== 'pending' || approval.expiresAt <= now.toISOString()) return { approved: false, runId };
			Object.assign(approval, { decision: 'approved', decidedBy: actor, decidedAt: now.toISOString() });
			return { approved: true, ...structuredClone(approval) };
		},
		async reject({ projectId, runId, actor, now = new Date() }) {
			const approval = testState().approvals.get(runId);
			if (!approval || approval.projectId !== projectId || approval.decision !== 'pending') return { rejected: false, runId };
			Object.assign(approval, { decision: 'rejected', decidedBy: actor, decidedAt: now.toISOString() });
			return { rejected: true, ...structuredClone(approval) };
		},
		async listForRun(runId, { projectId } = {}) {
			const approval = testState().approvals.get(runId);
			return approval && approval.projectId === projectId ? [rowToApproval({ id: approval.id, run_id: runId, plan_sha256: approval.planSha256, decision: approval.decision, requested_by: approval.requestedBy, decided_by: approval.decidedBy, requested_at: approval.requestedAt, decided_at: approval.decidedAt, expires_at: approval.expiresAt })] : [];
		}
	};
}

function rowToApproval(row) {
	return { id: row.id, runId: row.run_id, planSha256: row.plan_sha256, decision: row.decision, requestedBy: row.requested_by, decidedBy: row.decided_by, requestedAt: row.requested_at, decidedAt: row.decided_at, expiresAt: row.expires_at };
}
