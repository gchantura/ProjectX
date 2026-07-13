import { randomUUID } from 'node:crypto';
import { createSupabaseLeaseStore } from './supabaseStore.server.js';
import { incrementMetric, logEvent } from '../server/telemetry.js';

const DEFAULT_TTL_SECONDS = 300;

export async function acquireRunLease(runId, { projectId, ownerId = `worker-${randomUUID()}`, ttlSeconds = DEFAULT_TTL_SECONDS, store = createSupabaseLeaseStore(), now } = {}) {
	validateIds(runId, projectId, ownerId);
	const result = await store.claim({ runId, projectId, ownerId, ttlSeconds: boundedTtl(ttlSeconds), now });
	if (!result?.acquired) {
		incrementMetric('kcev_agent_run_lease_contention_total');
		throw Object.assign(new Error(`Run is already owned by an active worker until ${result?.expiresAt ?? 'lease expiry'}.`), { status: 409, code: 'RUN_LEASE_HELD', lease: publicLease(result) });
	}
	incrementMetric('kcev_agent_run_lease_claims_total', { outcome: 'acquired' });
	logEvent('info', 'agent_run.lease_acquired', { runId, ownerId, attempt: result.attempt, expiresAt: result.expiresAt });
	return { ...result, ttlSeconds: boundedTtl(ttlSeconds) };
}

export async function heartbeatRunLease(lease, { store = createSupabaseLeaseStore(), now } = {}) {
	const result = await store.heartbeat({ runId: lease.runId, leaseToken: lease.leaseToken, ttlSeconds: lease.ttlSeconds ?? DEFAULT_TTL_SECONDS, now });
	if (!result?.renewed) {
		incrementMetric('kcev_agent_run_lease_lost_total');
		throw Object.assign(new Error('Run lease expired or was superseded before the next effect.'), { status: 409, code: 'RUN_LEASE_LOST' });
	}
	return { ...lease, expiresAt: result.expiresAt };
}

export async function releaseRunLease(lease, { store = createSupabaseLeaseStore() } = {}) {
	if (!lease?.leaseToken) return false;
	const released = await store.release({ runId: lease.runId, leaseToken: lease.leaseToken });
	incrementMetric('kcev_agent_run_lease_releases_total', { outcome: released ? 'released' : 'not_owner' });
	logEvent(released ? 'info' : 'warn', 'agent_run.lease_released', { runId: lease.runId, ownerId: lease.ownerId, released });
	return released;
}

export function publicLease(lease = {}) {
	return { runId: lease.runId, ownerId: lease.ownerId, expiresAt: lease.expiresAt, attempt: lease.attempt };
}

function validateIds(runId, projectId, ownerId) {
	if (!/^run-[a-z0-9-]+$/i.test(String(runId ?? ''))) throw Object.assign(new Error('A valid run id is required for a lease.'), { status: 400 });
	if (!/^project-[a-z0-9-]+$/i.test(String(projectId ?? ''))) throw Object.assign(new Error('A valid project id is required for a lease.'), { status: 400 });
	if (!/^[a-z0-9:_-]{8,160}$/i.test(String(ownerId ?? ''))) throw Object.assign(new Error('A valid worker owner id is required for a lease.'), { status: 400 });
}

function boundedTtl(value) {
	return Math.min(Math.max(Math.trunc(Number(value) || DEFAULT_TTL_SECONDS), 30), 900);
}
