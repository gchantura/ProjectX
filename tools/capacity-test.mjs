import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export async function runCapacityTest({ url, requests = 500, concurrency = 25, warmup = 20, p95LimitMs = 750, maxErrorRate = 0.01, timeoutMs = 10_000 } = {}) {
	if (!url) throw new TypeError('Capacity test URL is required.');
	for (const [name, value] of Object.entries({ requests, concurrency, warmup, p95LimitMs, maxErrorRate, timeoutMs })) {
		if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative number.`);
	}
	if (requests < 1 || concurrency < 1) throw new TypeError('requests and concurrency must be at least 1.');

	await waitForTarget(url, timeoutMs);
	for (let index = 0; index < warmup; index += 1) await timedRequest(url, timeoutMs);

	const durations = [];
	const statuses = new Map();
	let failures = 0;
	let cursor = 0;
	const startedAt = performance.now();
	await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
		while (true) {
			const requestIndex = cursor;
			cursor += 1;
			if (requestIndex >= requests) return;
			const result = await timedRequest(url, timeoutMs);
			durations.push(result.durationMs);
			const status = result.status ?? 'network_error';
			statuses.set(status, (statuses.get(status) ?? 0) + 1);
			if (!result.ok) failures += 1;
		}
	}));
	const elapsedMs = performance.now() - startedAt;
	const sorted = durations.toSorted((a, b) => a - b);
	const errorRate = failures / requests;
	const p95 = percentile(sorted, 0.95);
	return {
		url, requests, concurrency, elapsedMs: round(elapsedMs), requestsPerSecond: round(requests / (elapsedMs / 1000)),
		latencyMs: { p50: percentile(sorted, 0.5), p95, p99: percentile(sorted, 0.99), max: round(sorted.at(-1) ?? 0) },
		errorRate: round(errorRate, 6),
		statuses: Object.fromEntries([...statuses.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))),
		thresholds: { p95LimitMs, maxErrorRate }, passed: p95 <= p95LimitMs && errorRate <= maxErrorRate
	};
}

async function waitForTarget(url, timeoutMs) {
	const deadline = Date.now() + Math.min(timeoutMs, 30_000);
	let lastError;
	while (Date.now() < deadline) {
		const result = await timedRequest(url, Math.min(timeoutMs, 2_000));
		if (result.ok) return;
		lastError = result.error ?? new Error(`Target returned HTTP ${result.status}.`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Capacity target did not become ready: ${lastError?.message ?? 'unknown error'}`);
}

async function timedRequest(url, timeoutMs) {
	const startedAt = performance.now();
	try {
		const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
		await response.arrayBuffer();
		return { ok: response.status >= 200 && response.status < 400, status: response.status, durationMs: performance.now() - startedAt };
	} catch (error) {
		return { ok: false, status: null, durationMs: performance.now() - startedAt, error };
	}
}

function percentile(sorted, ratio) { return sorted.length ? round(sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]) : 0; }
function round(value, digits = 2) { return Number(value.toFixed(digits)); }

async function main() {
	const { values } = parseArgs({ options: {
		url: { type: 'string' }, requests: { type: 'string', default: '500' }, concurrency: { type: 'string', default: '25' }, warmup: { type: 'string', default: '20' },
		'p95-ms': { type: 'string', default: '750' }, 'max-error-rate': { type: 'string', default: '0.01' }, 'timeout-ms': { type: 'string', default: '10000' }
	} });
	const summary = await runCapacityTest({ url: values.url, requests: Number(values.requests), concurrency: Number(values.concurrency), warmup: Number(values.warmup), p95LimitMs: Number(values['p95-ms']), maxErrorRate: Number(values['max-error-rate']), timeoutMs: Number(values['timeout-ms']) });
	console.log(JSON.stringify(summary, null, 2));
	if (!summary.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
