import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createIdentityStore } from './identityStore.server.js';
import { createDistributedRateLimitStore } from './rateLimitStore.server.js';

const WINDOW_MS = 60_000;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const ROLES = new Set(['viewer', 'operator', 'admin']);
const buckets = new Map();

export function securityConfig(env = process.env) {
	const production = env.NODE_ENV === 'production';
	const configuredTenantId = String(env.SUPABASE_TENANT_ID ?? '');
	const defaultTenantId = validTenantId(configuredTenantId) ? configuredTenantId : production ? '' : 'local-development';
	return {
		authRequired: env.KCEV_AUTH_REQUIRED === 'true' || production,
		production,
		operatorToken: env.KCEV_OPERATOR_TOKEN ?? '',
		operators: parseOperators(env.KCEV_OPERATORS_JSON, defaultTenantId),
		platformAdmins: parseSubjects(env.KCEV_PLATFORM_ADMIN_IDS),
		defaultTenantId,
		defaultTenantName: String(env.KCEV_TENANT_DISPLAY_NAME ?? 'Primary organization').slice(0, 160),
		sessionSecret: env.KCEV_SESSION_SECRET ?? '',
		trustedOrigins: parseOrigins(env.KCEV_TRUSTED_ORIGINS),
		rateLimit: boundedInt(env.KCEV_RATE_LIMIT_PER_MINUTE, 120, 10, 10_000)
	};
}

export function authenticateRequest(request, cookies, config = securityConfig(), now = new Date()) {
	if (!config.authRequired) return identity('local-admin', 'Local administrator', 'admin', 'development', { ...tenantFields(config), platformAdmin: true });
	const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
	if (bearer) return authenticateCredential(bearer, config);
	const session = cookies?.get?.('kcev_session');
	return verifySessionToken(session, config, now);
}

export async function authenticateRequestAsync(request, cookies, config = securityConfig(), { now = new Date(), identityStore = createIdentityStore() } = {}) {
	if (!config.authRequired) return identity('local-admin', 'Local administrator', 'admin', 'development', { ...tenantFields(config), platformAdmin: true });
	const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
	if (bearer) return authenticateCredentialAsync(bearer, config, identityStore);
	const session = cookies?.get?.('kcev_session');
	const verified = verifySessionToken(session, { ...config, allowDirectoryIdentities: true }, now);
	if (!verified.authenticated) return verified;
	const configured = verified.subject === 'bootstrap-admin' || (verified.accountTenantId === verified.tenantId && configuredIdentity(config, verified.subject, verified.role, verified.tenantId));
	if (!identityStore) return configured ? verified : denied('Session identity was revoked or changed.');
	if (configured) {
		const tenant = typeof identityStore.tenantStatus === 'function' ? await identityStore.tenantStatus(verified.tenantId).catch(() => undefined) : undefined;
		return tenant?.status === 'active' ? { ...verified, tenantName: tenant.name } : denied('Organization access is suspended.');
	}
	const stored = typeof identityStore.resolveMembership === 'function'
		? await identityStore.resolveMembership(verified.accountTenantId, verified.subject, verified.tenantId).catch(() => undefined)
		: await identityStore.get(verified.subject, { tenantId: verified.tenantId }).catch(() => undefined);
	return stored?.status === 'active' && stored.tenantStatus === 'active' && stored.role === verified.role && stored.tenantId === verified.tenantId
		? { ...verified, displayName: stored.displayName, tenantName: stored.tenantName, accountTenantId: stored.accountTenantId ?? verified.accountTenantId }
		: denied(stored?.tenantStatus === 'suspended' ? 'Organization access is suspended.' : 'Session identity was revoked or changed.');
}

export function authenticateCredential(candidate, config = securityConfig()) {
	if (typeof candidate !== 'string' || candidate.length < 32) return denied('Authentication required.');
	const digest = sha256(candidate);
	for (const operator of config.operators ?? []) {
		if (constantTimeEqual(digest, operator.tokenSha256)) return identity(operator.id, operator.name, operator.role, 'access-token', { tenantId: operator.tenantId, tenantName: operator.tenantName, platformAdmin: isPlatformAdmin(config, operator.id) });
	}
	if (String(config.operatorToken ?? '').length >= 32 && constantTimeEqual(candidate, config.operatorToken)) {
		const tenant = tenantFields(config);
		return tenant.tenantId ? identity('bootstrap-admin', 'Bootstrap administrator', 'admin', 'bootstrap-token', { ...tenant, platformAdmin: true }) : denied('Authentication tenant is not configured.');
	}
	return denied('Authentication required.');
}

export async function authenticateCredentialAsync(candidate, config = securityConfig(), identityStore = createIdentityStore()) {
	const configured = authenticateCredential(candidate, config);
	if (configured.authenticated) {
		if (!identityStore) return configured;
		const tenant = typeof identityStore.tenantStatus === 'function' ? await identityStore.tenantStatus(configured.tenantId).catch(() => undefined) : undefined;
		return tenant?.status === 'active' ? { ...configured, tenantName: tenant.name } : denied('Organization access is suspended.');
	}
	if (!identityStore || typeof candidate !== 'string' || candidate.length < 32) return configured;
	const stored = await identityStore.findByTokenSha256(sha256(candidate)).catch(() => undefined);
	return stored?.status === 'active' && stored.tenantStatus === 'active' && validTenantId(stored.tenantId) ? identity(stored.id, stored.displayName, stored.role, 'directory-token', { tenantId: stored.tenantId, accountTenantId: stored.accountTenantId ?? stored.tenantId, tenantName: stored.tenantName, platformAdmin: isPlatformAdmin(config, stored.id) }) : denied('Authentication required.');
}

export function createSessionToken(authenticatedIdentity, config = securityConfig(), now = new Date()) {
	if (!authenticatedIdentity?.authenticated) throw new Error('Authenticated identity is required.');
	if (String(config.sessionSecret ?? '').length < 32) throw new Error('KCEV_SESSION_SECRET must contain at least 32 characters.');
	const payload = {
		v: 3,
		sub: authenticatedIdentity.subject,
		name: authenticatedIdentity.displayName,
		role: authenticatedIdentity.role,
		pa: isPlatformAdmin(config, authenticatedIdentity.subject),
		tid: authenticatedIdentity.tenantId,
		htid: authenticatedIdentity.accountTenantId ?? authenticatedIdentity.tenantId,
		org: authenticatedIdentity.tenantName,
		iat: Math.floor(now.getTime() / 1000),
		exp: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS,
		jti: randomUUID()
	};
	const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
	if (!validTenantId(payload.tid)) throw new Error('Authenticated identity must be bound to a valid tenant.');
	if (!validTenantId(payload.htid)) throw new Error('Authenticated identity must have a valid home organization.');
	return `v3.${encoded}.${sign(encoded, config.sessionSecret)}`;
}

export function verifySessionToken(token, config = securityConfig(), now = new Date()) {
	if (String(config.sessionSecret ?? '').length < 32 || typeof token !== 'string') return denied('Authentication required.');
	const [version, encoded, signature, extra] = token.split('.');
	if (!['v2', 'v3'].includes(version) || !encoded || !signature || extra || !constantTimeEqual(signature, sign(encoded, config.sessionSecret))) return denied('Authentication required.');
	try {
		const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
		const nowSeconds = Math.floor(now.getTime() / 1000);
		if (payload.v !== Number(version.slice(1)) || !validSubject(payload.sub) || !ROLES.has(payload.role) || !validTenantId(payload.tid) || (payload.v === 3 && !validTenantId(payload.htid)) || !Number.isInteger(payload.exp) || payload.exp <= nowSeconds || payload.iat > nowSeconds + 60) return denied('Session expired or invalid.');
		if (!identityRemainsActive(payload, config)) return denied('Session identity was revoked or changed.');
		return identity(payload.sub, String(payload.name || payload.sub).slice(0, 160), payload.role, 'session', { tenantId: payload.tid, accountTenantId: payload.htid ?? payload.tid, tenantName: String(payload.org || `Organization ${payload.tid.slice(0, 8)}`).slice(0, 160), platformAdmin: isPlatformAdmin(config, payload.sub), expiresAt: new Date(payload.exp * 1000).toISOString(), sessionId: payload.jti });
	} catch {
		return denied('Authentication required.');
	}
}

export function authorizeRequest(authenticatedIdentity, pathname, method = 'GET') {
	if (!authenticatedIdentity?.authenticated) return { allowed: false, reason: 'Authentication required.' };
	const role = authenticatedIdentity.role;
	const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
	if (pathname.startsWith('/api/platform') && authenticatedIdentity.platformAdmin !== true) return { allowed: false, reason: 'Platform administrator authority required.' };
	const adminSurface = pathname === '/settings' || pathname === '/audit' || pathname.startsWith('/api/settings') || pathname.startsWith('/api/projects') || pathname.startsWith('/api/admin');
	if (adminSurface && role !== 'admin') return { allowed: false, reason: 'Administrator role required.' };
	if (mutation && role === 'viewer' && pathname !== '/api/auth/organization') return { allowed: false, reason: 'Operator role required.' };
	return { allowed: true };
}

export function validateOrigin(request, url, config = securityConfig()) {
	if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
	const origin = request.headers.get('origin');
	if (!origin) return request.headers.get('authorization')?.startsWith('Bearer ') === true;
	return origin === url.origin || config.trustedOrigins.includes(origin);
}

export function consumeRateLimit(key, limit, now = Date.now()) {
	pruneBuckets(now);
	const bucketKey = sha256(String(key));
	const bucket = buckets.get(bucketKey);
	if (!bucket || now >= bucket.resetAt) {
		buckets.set(bucketKey, { count: 1, resetAt: now + WINDOW_MS });
		return { allowed: true, remaining: limit - 1, resetAt: now + WINDOW_MS };
	}
	bucket.count += 1;
	return { allowed: bucket.count <= limit, remaining: Math.max(limit - bucket.count, 0), resetAt: bucket.resetAt };
}

export async function consumeRateLimitAsync(key, limit, { store = createDistributedRateLimitStore(), production = process.env.NODE_ENV === 'production', now = Date.now() } = {}) {
	if (store) return store.consume(key, limit);
	if (production) throw Object.assign(new Error('Shared rate-limit enforcement is required in production.'), { status: 503 });
	return { ...consumeRateLimit(key, limit, now), backend: 'process-memory' };
}

export function sessionCookieOptions(url) {
	return { path: '/', httpOnly: true, sameSite: 'strict', secure: url.protocol === 'https:', maxAge: SESSION_TTL_SECONDS };
}

export function securityHeaders(nonce) {
	return {
		'content-security-policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
		'referrer-policy': 'no-referrer',
		'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'DENY',
		'cross-origin-opener-policy': 'same-origin',
		'cross-origin-resource-policy': 'same-origin'
	};
}

function parseOperators(value, defaultTenantId) {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		const candidates = parsed.filter((item) => validSubject(item?.id) && ROLES.has(item?.role) && /^[a-f0-9]{64}$/i.test(item?.tokenSha256 ?? '') && validTenantId(item?.tenantId ?? defaultTenantId)).map((item) => ({ id: item.id, name: String(item.name || item.id).slice(0, 160), role: item.role, tokenSha256: item.tokenSha256.toLowerCase(), tenantId: item.tenantId ?? defaultTenantId, tenantName: String(item.tenantName || `Organization ${String(item.tenantId ?? defaultTenantId).slice(0, 8)}`).slice(0, 160) })).slice(0, 500);
		const digestCounts = new Map();
		for (const operator of candidates) digestCounts.set(operator.tokenSha256, (digestCounts.get(operator.tokenSha256) ?? 0) + 1);
		return candidates.filter((operator) => digestCounts.get(operator.tokenSha256) === 1);
	} catch { return []; }
}
function identity(subject, displayName, role, method, extra = {}) { return { authenticated: true, subject, displayName, role, method, ...extra }; }
function denied(reason) { return { authenticated: false, reason }; }
function identityRemainsActive(payload, config) {
	if (payload.pa !== isPlatformAdmin(config, payload.sub)) return false;
	if (payload.sub === 'bootstrap-admin') return String(config.operatorToken ?? '').length >= 32 && payload.role === 'admin' && payload.tid === tenantFields(config).tenantId;
	if (config.allowDirectoryIdentities) return true;
	const operator = (config.operators ?? []).find((item) => item.id === payload.sub && item.tenantId === payload.tid);
	return Boolean(operator && operator.role === payload.role);
}
function configuredIdentity(config, subject, role, tenantId) { return (config.operators ?? []).some((item) => item.id === subject && item.role === role && item.tenantId === tenantId); }
function isPlatformAdmin(config, subject) { return subject === 'bootstrap-admin' || (config.platformAdmins ?? []).includes(subject); }
function sign(payload, secret) { return createHmac('sha256', secret).update(payload).digest('base64url'); }
function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function validSubject(value) { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{1,127}$/.test(value); }
function validTenantId(value) { return value === 'local-development' || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? '')); }
function tenantFields(config) { const tenantId = validTenantId(config?.defaultTenantId) ? config.defaultTenantId : config?.production ? null : 'local-development'; return { tenantId, tenantName: String(config?.defaultTenantName ?? (tenantId === 'local-development' ? 'Local workspace' : `Organization ${String(tenantId ?? '').slice(0, 8)}`)).slice(0, 160) }; }
function constantTimeEqual(left, right) {
	const leftHash = createHash('sha256').update(String(left)).digest();
	const rightHash = createHash('sha256').update(String(right)).digest();
	return timingSafeEqual(leftHash, rightHash) && String(left).length === String(right).length;
}
function parseOrigins(value) { return String(value ?? '').split(',').map((item) => item.trim()).filter((item) => /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(item)); }
function parseSubjects(value) { return [...new Set(String(value ?? '').split(',').map((item) => item.trim()).filter(validSubject))].slice(0, 100); }
function boundedInt(value, fallback, min, max) { const number = Number(value); return Number.isInteger(number) ? Math.min(Math.max(number, min), max) : fallback; }
function pruneBuckets(now) { if (buckets.size < 10_000) return; for (const [key, bucket] of buckets) if (now >= bucket.resetAt) buckets.delete(key); }
