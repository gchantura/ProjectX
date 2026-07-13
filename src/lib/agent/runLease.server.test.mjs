import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { acquireRunLease, heartbeatRunLease, releaseRunLease } from './runLease.server.js';
import { clearSupabaseTestState, createSupabaseLeaseStore } from './supabaseStore.server.js';

beforeEach(() => clearSupabaseTestState());

test('atomically rejects concurrent workers and releases only for the lease owner', async () => {
	const store = createSupabaseLeaseStore();
	const first = await acquireRunLease('run-lease-test', { projectId: 'project-lease-test', ownerId: 'worker:first', store });
	await assert.rejects(() => acquireRunLease('run-lease-test', { projectId: 'project-lease-test', ownerId: 'worker:second', store }), (error) => error.code === 'RUN_LEASE_HELD' && error.status === 409);
	assert.equal(await store.release({ runId: first.runId, leaseToken: '00000000-0000-4000-8000-000000000000' }), false);
	assert.equal(await releaseRunLease(first, { store }), true);
	const second = await acquireRunLease('run-lease-test', { projectId: 'project-lease-test', ownerId: 'worker:second', store });
	assert.equal(second.attempt, 1);
});

test('heartbeats active ownership and permits recovery after expiry', async () => {
	const store = createSupabaseLeaseStore();
	const startedAt = new Date('2026-07-13T00:00:00.000Z');
	const first = await acquireRunLease('run-expiry-test', { projectId: 'project-lease-test', ownerId: 'worker:first', ttlSeconds: 30, store, now: startedAt });
	const renewed = await heartbeatRunLease(first, { store, now: new Date('2026-07-13T00:00:10.000Z') });
	assert.equal(renewed.expiresAt, '2026-07-13T00:00:40.000Z');
	const recovered = await acquireRunLease('run-expiry-test', { projectId: 'project-lease-test', ownerId: 'worker:recovery', ttlSeconds: 30, store, now: new Date('2026-07-13T00:00:41.000Z') });
	assert.equal(recovered.attempt, 2);
	await assert.rejects(() => heartbeatRunLease(first, { store, now: new Date('2026-07-13T00:00:42.000Z') }), (error) => error.code === 'RUN_LEASE_LOST');
});
