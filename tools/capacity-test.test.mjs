import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { runCapacityTest } from './capacity-test.mjs';

test('measures bounded latency and status evidence against a live server', async () => {
	const server = createServer((_request, response) => { response.writeHead(200); response.end('ok'); });
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const summary = await runCapacityTest({ url: `http://127.0.0.1:${server.address().port}`, requests: 20, concurrency: 4, warmup: 2, p95LimitMs: 1_000, maxErrorRate: 0 });
		assert.equal(summary.passed, true);
		assert.equal(summary.statuses['200'], 20);
		assert.equal(summary.errorRate, 0);
		assert.ok(summary.latencyMs.p95 > 0);
		assert.ok(summary.requestsPerSecond > 0);
	} finally { await new Promise((resolve) => server.close(resolve)); }
});

test('refuses to benchmark a target that never becomes ready', async () => {
	const server = createServer((_request, response) => { response.writeHead(503); response.end('busy'); });
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		await assert.rejects(() => runCapacityTest({ url: `http://127.0.0.1:${server.address().port}`, requests: 5, concurrency: 1, warmup: 0, timeoutMs: 300 }), /did not become ready/);
	} finally { await new Promise((resolve) => server.close(resolve)); }
});
