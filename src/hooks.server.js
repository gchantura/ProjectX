import { randomBytes, randomUUID } from 'node:crypto';
import { authenticateRequestAsync, authorizeRequest, consumeRateLimitAsync, securityConfig, securityHeaders, validateOrigin } from '$lib/server/security.js';
import { createTraceContext, formatTraceparent, incrementMetric, logEvent, observeMetric, setTelemetryContextFields, withTelemetryContext } from '$lib/server/telemetry.js';
import { recordMutationAudit } from '$lib/server/auditStore.server.js';
import { authenticateScimCredential } from '$lib/server/identityLifecycleStore.server.js';
import { withTenantContext } from '$lib/server/tenantContext.js';

const PUBLIC_PATHS = new Set(['/login', '/api/health/live', '/api/health/ready', '/api/auth/session', '/api/auth/oidc/start', '/api/auth/oidc/callback']);
const SCIM_PREFIX = '/api/scim/v2';

export async function handle({ event, resolve }) {
	const trace = createTraceContext(event.request.headers.get('traceparent'));
	return withTelemetryContext(trace, () => handleRequest({ event, resolve, trace }));
}

async function handleRequest({ event, resolve, trace }) {
	const started = performance.now();
	const requestId = event.request.headers.get('x-request-id')?.slice(0, 128) || randomUUID();
	event.locals.requestId = requestId;
	event.locals.traceId = trace.traceId;
	event.locals.spanId = trace.spanId;
	setTelemetryContextFields({ requestId, traceId: trace.traceId, spanId: trace.spanId, parentSpanId: trace.parentSpanId });
	const config = securityConfig();
	const clientKey = event.getClientAddress?.() ?? 'unknown';
	let rate;
	try { rate = await consumeRateLimitAsync(clientKey, config.rateLimit); }
	catch (error) {
		incrementMetric('kcev_rate_limit_backend_failures_total');
		logEvent('error', 'rate_limit_backend_failed', { requestId, error: error?.message });
		return jsonError(503, 'Request admission is temporarily unavailable.', requestId, { 'retry-after': '5' });
	}
	if (!rate.allowed) return jsonError(429, 'Rate limit exceeded.', requestId, { 'retry-after': String(Math.ceil((rate.resetAt - Date.now()) / 1000)) });

	if (!validateOrigin(event.request, event.url, config)) return jsonError(403, 'Request origin is not trusted.', requestId);
	if (!PUBLIC_PATHS.has(event.url.pathname)) {
		const identity = event.url.pathname.startsWith(SCIM_PREFIX)
			? await authenticateScimRequest(event.request)
			: await authenticateRequestAsync(event.request, event.cookies, config);
		if (!identity.authenticated) {
			if (event.url.pathname.startsWith(SCIM_PREFIX)) return scimErrorResponse(identity.status ?? 401, identity.reason, requestId);
			if (event.request.method === 'GET' && !event.url.pathname.startsWith('/api/')) {
				return redirectResponse(`/login?returnTo=${encodeURIComponent(event.url.pathname + event.url.search)}`, requestId);
			}
			return jsonError(401, identity.reason, requestId, { 'www-authenticate': 'Bearer realm="KcevAgent"' });
		}
		event.locals.identity = identity;
		event.locals.tenantId = identity.tenantId;
		setTelemetryContextFields({ actor: identity.subject, role: identity.role, tenantId: identity.tenantId, tenantName: identity.tenantName });
		const authorization = authorizeRequest(identity, event.url.pathname, event.request.method);
		if (!authorization.allowed) return jsonError(403, authorization.reason, requestId);
	}
	if (event.url.pathname === '/login') {
		const identity = await authenticateRequestAsync(event.request, event.cookies, config);
		if (identity.authenticated && config.authRequired) return redirectResponse('/', requestId);
	}
	const tenant = event.locals.identity ? { id: event.locals.identity.tenantId, name: event.locals.identity.tenantName } : null;
	return withTenantContext(tenant, () => resolveRequest({ event, resolve, trace, requestId, rate, started }));
}

async function resolveRequest({ event, resolve, trace, requestId, rate, started }) {
	try {
		const nonce = randomBytes(16).toString('base64');
		const response = await resolve(event, {
			transformPageChunk: ({ html }) => html
				.replace('%sveltekit.nonce%', nonce)
				.replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)
		});
		for (const [name, value] of Object.entries(securityHeaders(nonce))) response.headers.set(name, value);
		try {
			const auditStatus = await recordMutationAudit({ identity: event.locals.identity, method: event.request.method, pathname: event.url.pathname, status: response.status, requestId, traceId: trace.traceId });
			response.headers.set('x-audit-status', auditStatus);
		} catch (error) {
			response.headers.set('x-audit-status', 'unavailable');
			incrementMetric('kcev_audit_write_failures_total');
			logEvent('error', 'audit_write_failed', { requestId, path: routeLabel(event.url.pathname), error: error?.message });
		}
		response.headers.set('x-request-id', requestId);
		response.headers.set('traceparent', formatTraceparent(trace));
		response.headers.set('x-ratelimit-remaining', String(rate.remaining));
		response.headers.set('x-ratelimit-backend', rate.backend);
		incrementMetric('kcev_http_requests_total', { method: event.request.method, status: response.status });
		observeMetric('kcev_http_request_duration_ms', performance.now() - started, { route: event.route.id ?? routeLabel(event.url.pathname) });
		logEvent('info', 'http_request', { requestId, method: event.request.method, path: routeLabel(event.url.pathname), status: response.status, durationMs: Math.round(performance.now() - started) });
		return response;
	} catch (error) {
		incrementMetric('kcev_http_requests_total', { method: event.request.method, status: 500 });
		logEvent('error', 'http_request_failed', { requestId, method: event.request.method, path: routeLabel(event.url.pathname), error: error?.message });
		throw error;
	}
}

function jsonError(status, message, requestId, headers = {}) { return new Response(JSON.stringify({ error: message, requestId }), { status, headers: { 'content-type': 'application/json', 'x-request-id': requestId, traceparent: formatTraceparent(), ...headers } }); }
async function authenticateScimRequest(request) {
	const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
	return authenticateScimCredential(token);
}
function scimErrorResponse(status, detail, requestId) { return new Response(JSON.stringify({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(status), detail, requestId }), { status, headers: { 'content-type': 'application/scim+json', 'www-authenticate': 'Bearer realm="KcevAgent SCIM"', 'x-request-id': requestId, traceparent: formatTraceparent() } }); }
function redirectResponse(location, requestId) { return new Response(null, { status: 303, headers: { location, 'x-request-id': requestId, traceparent: formatTraceparent() } }); }
function routeLabel(pathname) { return pathname.replace(/run-[a-z0-9-]+/gi, ':runId').slice(0, 160); }
