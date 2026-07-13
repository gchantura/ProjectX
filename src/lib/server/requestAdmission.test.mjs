import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestAdmissionConfig, requestAdmissionSnapshot, resetRequestAdmissionForTests, tryAcquireRequestSlot } from './requestAdmission.js';

test.beforeEach(() => resetRequestAdmissionForTests());

test('bounds per-replica concurrency and recovers when a slot is released', () => {
	const env = { KCEV_MAX_INFLIGHT_REQUESTS: '2' };
	const first = tryAcquireRequestSlot({ env, pathname: '/api/runs' });
	const second = tryAcquireRequestSlot({ env, pathname: '/api/modules' });
	const rejected = tryAcquireRequestSlot({ env, pathname: '/api/projects' });
	assert.equal(first.admitted, true);
	assert.equal(second.admitted, true);
	assert.deepEqual({ admitted: rejected.admitted, active: rejected.active, limit: rejected.limit, remaining: rejected.remaining }, { admitted: false, active: 2, limit: 2, remaining: 0 });
	assert.deepEqual(requestAdmissionSnapshot(), { active: 2, limit: 2, rejected: 1 });
	first.release();
	first.release();
	assert.equal(tryAcquireRequestSlot({ env, pathname: '/api/projects' }).admitted, true);
	second.release();
});

test('keeps liveness available while ordinary traffic is saturated', () => {
	const env = { KCEV_MAX_INFLIGHT_REQUESTS: '1' };
	const occupied = tryAcquireRequestSlot({ env, pathname: '/slow' });
	const live = tryAcquireRequestSlot({ env, pathname: '/api/health/live' });
	assert.equal(live.admitted, true);
	assert.equal(live.bypassed, true);
	assert.equal(requestAdmissionSnapshot().active, 1);
	live.release();
	occupied.release();
});

test('uses conservative defaults and clamps invalid capacity configuration', () => {
	assert.equal(requestAdmissionConfig({}).maxInflightRequests, 200);
	assert.equal(requestAdmissionConfig({ KCEV_MAX_INFLIGHT_REQUESTS: '0' }).maxInflightRequests, 1);
	assert.equal(requestAdmissionConfig({ KCEV_MAX_INFLIGHT_REQUESTS: '999999' }).maxInflightRequests, 5_000);
	assert.equal(requestAdmissionConfig({ KCEV_MAX_INFLIGHT_REQUESTS: 'not-a-number' }).maxInflightRequests, 200);
});
