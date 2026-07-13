import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { requestAdmissionSnapshot } from './requestAdmission.js';

const startedAt = Date.now();
const counters = new Map();
const histograms = new Map();
const contextStorage = new AsyncLocalStorage();
const MAX_SERIES_PER_METRIC = 200;
const METRICS = new Map([
	['kcev_http_requests_total', metric('counter', 'HTTP requests handled by this application replica.', ['method', 'status'])],
	['kcev_http_request_duration_ms', metric('summary', 'HTTP request duration in milliseconds.', ['route'])],
	['kcev_rate_limit_backend_failures_total', metric('counter', 'Shared rate-limit backend failures.')],
	['kcev_audit_write_failures_total', metric('counter', 'Security audit persistence failures.')],
	['kcev_maintenance_runs_total', metric('counter', 'Maintenance runs by outcome.', ['status'])],
	['kcev_maintenance_duration_ms', metric('summary', 'Maintenance duration in milliseconds.', ['status'])],
	['kcev_agent_run_lease_contention_total', metric('counter', 'Run lease acquisition conflicts.')],
	['kcev_agent_run_lease_claims_total', metric('counter', 'Run lease claims by outcome.', ['outcome'])],
	['kcev_agent_run_lease_lost_total', metric('counter', 'Run leases lost before completion.')],
	['kcev_agent_run_lease_releases_total', metric('counter', 'Run lease releases by outcome.', ['outcome'])],
	['kcev_agent_runs_total', metric('counter', 'Agent runs completed by provider, status, and operation.', ['provider', 'status', 'operation'])],
	['kcev_agent_steps_total', metric('counter', 'Agent steps completed by provider and status.', ['provider', 'status'])],
	['kcev_agent_tokens_total', metric('counter', 'Model tokens consumed by provider and direction.', ['provider', 'direction'])],
	['kcev_agent_run_duration_ms', metric('summary', 'Agent run duration in milliseconds.', ['provider', 'status', 'operation'])],
	['kcev_agent_estimated_cost_usd', metric('summary', 'Estimated agent run cost in US dollars.', ['provider'])]
]);

export function createTraceContext(traceparent, fields = {}) {
	const parsed = parseTraceparent(traceparent);
	return { traceId: parsed?.traceId ?? randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), traceFlags: parsed?.traceFlags ?? '01', parentSpanId: parsed?.spanId ?? null, ...fields };
}

export function withTelemetryContext(context, callback) { return contextStorage.run(context, callback); }
export function setTelemetryContextFields(fields) { const context = contextStorage.getStore(); if (context) Object.assign(context, sanitize(fields)); }
export function currentTelemetryContext() { return { ...(contextStorage.getStore() ?? {}) }; }
export function formatTraceparent(context = contextStorage.getStore()) { return context?.traceId && context?.spanId ? `00-${context.traceId}-${context.spanId}-${context.traceFlags ?? '01'}` : null; }

export function incrementMetric(name, labels = {}, value = 1) {
	const key = admittedMetricKey(name, labels, counters);
	if (!key) return false;
	counters.set(key, (counters.get(key) ?? 0) + value);
	return true;
}

export function observeMetric(name, value, labels = {}) {
	const key = admittedMetricKey(name, labels, histograms);
	if (!key) return false;
	const current = histograms.get(key) ?? { count: 0, sum: 0 };
	current.count += 1;
	current.sum += Number(value) || 0;
	histograms.set(key, current);
	return true;
}

export function logEvent(level, event, fields = {}) {
	const record = { timestamp: new Date().toISOString(), level, event, ...sanitize(contextStorage.getStore() ?? {}), ...sanitize(fields) };
	const output = JSON.stringify(record);
	if (level === 'error') console.error(output); else if (level === 'warn') console.warn(output); else console.info(output);
}

export function prometheusMetrics() {
	const memory = process.memoryUsage();
	const admission = requestAdmissionSnapshot();
	const lines = [
		'# HELP kcev_uptime_seconds Process uptime in seconds.', '# TYPE kcev_uptime_seconds gauge', `kcev_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
		'# HELP kcev_process_resident_memory_bytes Resident memory used by this application replica.', '# TYPE kcev_process_resident_memory_bytes gauge', `kcev_process_resident_memory_bytes ${memory.rss}`,
		'# HELP kcev_process_heap_used_bytes JavaScript heap used by this application replica.', '# TYPE kcev_process_heap_used_bytes gauge', `kcev_process_heap_used_bytes ${memory.heapUsed}`,
		'# HELP kcev_telemetry_dropped_series_total Metric series rejected by registry or cardinality controls.', '# TYPE kcev_telemetry_dropped_series_total counter', `kcev_telemetry_dropped_series_total ${droppedSeries}`,
		'# HELP kcev_request_admission_active Requests currently admitted by this application replica.', '# TYPE kcev_request_admission_active gauge', `kcev_request_admission_active ${admission.active}`,
		'# HELP kcev_request_admission_limit Maximum concurrent requests admitted by this application replica.', '# TYPE kcev_request_admission_limit gauge', `kcev_request_admission_limit ${admission.limit}`,
		'# HELP kcev_request_admission_rejections_total Requests rejected because this application replica was saturated.', '# TYPE kcev_request_admission_rejections_total counter', `kcev_request_admission_rejections_total ${admission.rejected}`
	];
	for (const [name, definition] of METRICS) {
		const samples = definition.type === 'counter' ? counters : histograms;
		const matching = [...samples.entries()].filter(([key]) => key === name || key.startsWith(`${name}{`));
		if (!matching.length) continue;
		lines.push(`# HELP ${name} ${definition.help}`, `# TYPE ${name} ${definition.type}`);
		for (const [key, value] of matching) definition.type === 'counter' ? lines.push(`${key} ${value}`) : lines.push(`${withSuffix(key, '_count')} ${value.count}`, `${withSuffix(key, '_sum')} ${value.sum}`);
	}
	return `${lines.join('\n')}\n`;
}

export function telemetrySnapshot() {
	return {
		uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
		counters: [...counters.entries()].map(([key, value]) => ({ key, value })),
		histograms: [...histograms.entries()].map(([key, value]) => ({ key, count: value.count, sum: value.sum }))
	};
}

let droppedSeries = 0;
function metric(type, help, labels = []) { return { type, help, labels: [...labels].sort() }; }
function admittedMetricKey(name, labels, store) {
	const definition = METRICS.get(name) ?? (process.env.NODE_ENV === 'test' && /^kcev_test_[a-z0-9_]+$/.test(name) ? metric('counter', 'Test metric.', Object.keys(labels)) : null);
	if (!definition || definition.type === 'counter' !== (store === counters)) { droppedSeries += 1; return null; }
	const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
	if (entries.length !== definition.labels.length || entries.some(([key], index) => key !== definition.labels[index])) { droppedSeries += 1; return null; }
	const key = entries.length ? `${name}{${entries.map(([label, value]) => `${label}="${safeLabel(value)}"`).join(',')}}` : name;
	if (!store.has(key) && [...store.keys()].filter((candidate) => candidate === name || candidate.startsWith(`${name}{`)).length >= MAX_SERIES_PER_METRIC) { droppedSeries += 1; return null; }
	return key;
}
function safeLabel(value) { return String(value).replace(/[^a-zA-Z0-9_./:[\]-]/g, '_').slice(0, 120); }
function withSuffix(key, suffix) { const brace = key.indexOf('{'); return brace === -1 ? `${key}${suffix}` : `${key.slice(0, brace)}${suffix}${key.slice(brace)}`; }
function sanitize(fields) {
	return sanitizeValue(fields, 0);
}
function sanitizeValue(value, depth) {
	if (depth > 6) return '[depth-limited]';
	if (typeof value === 'string') return value.slice(0, 1000);
	if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
	if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
	if (typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|password|authorization|api.?key/i.test(key)).slice(0, 100).map(([key, item]) => [key, sanitizeValue(item, depth + 1)]));
	return String(value).slice(0, 1000);
}
function parseTraceparent(value) {
	const match = String(value ?? '').trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
	if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
	return { traceId: match[1].toLowerCase(), spanId: match[2].toLowerCase(), traceFlags: match[3].toLowerCase() };
}
