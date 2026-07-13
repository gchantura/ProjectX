import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createManagedServer } from './server.mjs';

test('serves traffic, enters drain immediately, and closes after the drain delay', async () => {
	const events = [];
	const managed = createManagedServer({ handler: (_request, response) => { response.writeHead(200); response.end('ok'); }, env: { KCEV_DRAIN_DELAY_MS: '100', KCEV_SHUTDOWN_GRACE_MS: '5000' }, logger: (_level, event) => events.push(event) });
	const address = await managed.start(0, '127.0.0.1');
	const origin = `http://127.0.0.1:${address.port}`;
	assert.equal(await (await fetch(origin)).text(), 'ok');
	const shutdown = managed.beginDrain('test');
	assert.equal(managed.isDraining(), true);
	const draining = await fetch(origin);
	assert.equal(draining.status, 503);
	assert.deepEqual(await draining.json(), { status: 'draining' });
	assert.deepEqual(await shutdown, { forced: false });
	assert.deepEqual(events, ['server.started', 'server.draining', 'server.stopped']);
});

test('rejects excess traffic, preserves liveness, and admits work after recovery', async () => {
	let releaseSlow;
	let markStarted;
	const slowStarted = new Promise((resolve) => { markStarted = resolve; });
	const managed = createManagedServer({
		handler: (request, response) => {
			if (request.url === '/slow') {
				markStarted();
				releaseSlow = () => { response.writeHead(200); response.end('slow complete'); };
				return;
			}
			response.writeHead(200);
			response.end('ok');
		},
		env: { KCEV_MAX_INFLIGHT_REQUESTS: '1', KCEV_DRAIN_DELAY_MS: '0', KCEV_SHUTDOWN_GRACE_MS: '5000' },
		logger: () => {}
	});
	const address = await managed.start(0, '127.0.0.1');
	const origin = `http://127.0.0.1:${address.port}`;
	const slowRequest = fetch(`${origin}/slow`);
	await slowStarted;
	const overloaded = await fetch(`${origin}/ordinary`);
	assert.equal(overloaded.status, 503);
	assert.equal(overloaded.headers.get('retry-after'), '2');
	assert.equal(overloaded.headers.get('x-concurrency-limit'), '1');
	assert.deepEqual(await overloaded.json(), { status: 'overloaded' });
	const liveness = await fetch(`${origin}/api/health/live`);
	assert.equal(liveness.status, 200);
	releaseSlow();
	assert.equal(await (await slowRequest).text(), 'slow complete');
	const recovered = await fetch(`${origin}/ordinary`);
	assert.equal(recovered.status, 200);
	await managed.beginDrain('test');
});
