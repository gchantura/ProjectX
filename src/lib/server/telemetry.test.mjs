import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTraceContext, currentTelemetryContext, formatTraceparent, incrementMetric, logEvent, observeMetric, prometheusMetrics, setTelemetryContextFields, telemetrySnapshot, withTelemetryContext } from './telemetry.js';

test('continues valid W3C trace context with a new server span', async () => {
	const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
	const context = createTraceContext(incoming);
	assert.equal(context.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
	assert.equal(context.parentSpanId, '00f067aa0ba902b7');
	assert.match(context.spanId, /^[a-f0-9]{16}$/);
	assert.equal(formatTraceparent(context), `00-${context.traceId}-${context.spanId}-01`);
	await withTelemetryContext(context, async () => {
		setTelemetryContextFields({ requestId: 'request-1', actor: 'alice@example.com' });
		await Promise.resolve();
		assert.equal(currentTelemetryContext().requestId, 'request-1');
		assert.equal(currentTelemetryContext().actor, 'alice@example.com');
	});
});

test('rejects malformed trace parents and enriches redacted structured logs', () => {
	const context = createTraceContext('00-00000000000000000000000000000000-0000000000000000-01');
	assert.match(context.traceId, /^[a-f0-9]{32}$/);
	let output = '';
	const original = console.info;
	console.info = (value) => { output = value; };
	try { withTelemetryContext({ traceId: context.traceId, spanId: context.spanId, actor: 'alice' }, () => logEvent('info', 'test.event', { apiKey: 'never-log', result: 'ok', nested: { password: 'also-never-log', evidence: 'safe' } })); }
	finally { console.info = original; }
	const record = JSON.parse(output);
	assert.equal(record.traceId, context.traceId);
	assert.equal(record.actor, 'alice');
	assert.equal(record.result, 'ok');
	assert.equal('apiKey' in record, false);
	assert.equal('password' in record.nested, false);
	assert.equal(record.nested.evidence, 'safe');
});

test('exposes bounded process telemetry snapshots', () => {
	incrementMetric('kcev_test_counter_total', { outcome: 'ok' });
	const snapshot = telemetrySnapshot();
	assert.ok(snapshot.uptimeSeconds >= 0);
	assert.ok(snapshot.counters.some((metric) => metric.key.includes('kcev_test_counter_total') && metric.value >= 1));
});

test('exports declared Prometheus metadata and valid summary samples', () => {
	incrementMetric('kcev_http_requests_total', { method: 'GET', status: 200 });
	observeMetric('kcev_http_request_duration_ms', 12.5, { route: '/api/runs/[id]' });
	const output = prometheusMetrics();
	assert.match(output, /# TYPE kcev_http_requests_total counter/);
	assert.match(output, /kcev_http_requests_total\{method="GET",status="200"\} 1/);
	assert.match(output, /# TYPE kcev_http_request_duration_ms summary/);
	assert.match(output, /kcev_http_request_duration_ms_count\{route="\/api\/runs\/\[id\]"\} 1/);
	assert.match(output, /kcev_process_resident_memory_bytes \d+/);
	assert.match(output, /# TYPE kcev_request_admission_active gauge/);
	assert.match(output, /# TYPE kcev_request_admission_rejections_total counter/);
});

test('rejects unknown metrics and undeclared high-cardinality labels', () => {
	assert.equal(incrementMetric('customer_supplied_metric', { user: 'secret@example.com' }), false);
	assert.equal(incrementMetric('kcev_http_requests_total', { method: 'GET', status: 200, user: 'secret@example.com' }), false);
	assert.doesNotMatch(prometheusMetrics(), /secret@example\.com|customer_supplied_metric/);
});
