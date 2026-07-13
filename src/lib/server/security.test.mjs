import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authenticateCredential, authenticateCredentialAsync, authenticateRequest, authenticateRequestAsync, authorizeRequest, consumeRateLimit, consumeRateLimitAsync, createSessionToken, securityConfig, validateOrigin, verifySessionToken } from './security.js';

describe('server security boundary', () => {
	it('requires a strong operator token in production', () => {
		const config = securityConfig({ NODE_ENV: 'production', KCEV_OPERATOR_TOKEN: 'short' });
		const result = authenticateRequest(new Request('https://agent.test/api/runs'), { get: () => undefined }, config);
		assert.equal(config.authRequired, true);
		assert.equal(result.authenticated, false);
		assert.match(result.reason, /authentication required/i);
	});
	it('accepts exact bearer credentials without exposing them', () => {
		const token = 'a'.repeat(40);
		const request = new Request('https://agent.test/api/runs', { headers: { authorization: `Bearer ${token}` } });
		assert.equal(authenticateRequest(request, null, { authRequired: true, operatorToken: token }).authenticated, true);
		assert.equal(authenticateRequest(new Request(request.url, { headers: { authorization: 'Bearer wrong' } }), null, { authRequired: true, operatorToken: token }).authenticated, false);
	});
	it('creates signed identity sessions without storing the access token', () => {
		const accessToken = 'access-'.padEnd(40, 'a');
		const config = { authRequired: true, operatorToken: accessToken, operators: [], sessionSecret: 'session-'.padEnd(40, 's') };
		const identity = authenticateCredential(accessToken, config);
		const session = createSessionToken(identity, config, new Date('2026-07-13T00:00:00.000Z'));
		assert.equal(session.includes(accessToken), false);
		const verified = verifySessionToken(session, config, new Date('2026-07-13T01:00:00.000Z'));
		assert.equal(verified.authenticated, true);
		assert.equal(verified.subject, 'bootstrap-admin');
		assert.equal(verified.role, 'admin');
		assert.equal(verified.platformAdmin, true);
		assert.equal(verified.tenantId, 'local-development');
		assert.equal(verified.expiresAt, '2026-07-13T08:00:00.000Z');
		assert.match(verified.sessionId, /^[a-f0-9-]{36}$/);
		assert.equal(verifySessionToken(`${session}tampered`, config).authenticated, false);
		assert.match(verifySessionToken(session, config, new Date('2026-07-13T08:00:01.000Z')).reason, /expired|invalid/i);
	});
	it('authenticates named operators by token digest and enforces roles', () => {
		const token = 'named-'.padEnd(40, 'n');
		const digest = '3a09af66b1e9ee92e8c170cb3363ccd1c76f84807ecc74ec704ea06f412864d8';
		const config = securityConfig({ KCEV_AUTH_REQUIRED: 'true', KCEV_OPERATORS_JSON: JSON.stringify([{ id: 'reviewer@example.com', name: 'Review User', role: 'viewer', tokenSha256: digest }]) });
		const named = authenticateCredential(token, config);
		assert.equal(named.authenticated, true);
		assert.equal(named.subject, 'reviewer@example.com');
		assert.equal(authorizeRequest(named, '/api/runs', 'GET').allowed, true);
		assert.equal(authorizeRequest(named, '/api/runs', 'POST').allowed, false);
		assert.equal(authorizeRequest({ ...named, role: 'operator' }, '/api/runs', 'POST').allowed, true);
		assert.equal(authorizeRequest({ ...named, role: 'operator' }, '/settings', 'GET').allowed, false);
		assert.equal(authorizeRequest({ ...named, role: 'admin' }, '/settings', 'GET').allowed, true);
		const sessionConfig = { ...config, sessionSecret: 'named-session-secret-that-is-long-enough' };
		const session = createSessionToken(named, sessionConfig);
		assert.equal(verifySessionToken(session, sessionConfig).authenticated, true);
		assert.match(verifySessionToken(session, { ...sessionConfig, operators: [] }).reason, /revoked|changed/i);
		assert.match(verifySessionToken(session, { ...sessionConfig, operators: [{ ...config.operators[0], role: 'operator' }] }).reason, /revoked|changed/i);
	});
	it('authenticates and revokes durable directory identities', async () => {
		const token = 'directory-'.padEnd(40, 'd');
		const stored = { id: 'durable@example.com', displayName: 'Durable User', role: 'operator', status: 'active', tenantStatus: 'active', tenantId: '00000000-0000-4000-8000-000000000002', tenantName: 'Contoso' };
		const identityStore = { findByTokenSha256: async () => stored, get: async () => stored };
		const config = { authRequired: true, operatorToken: '', operators: [], sessionSecret: 'directory-session-secret-that-is-long' };
		const identity = await authenticateCredentialAsync(token, config, identityStore);
		assert.equal(identity.subject, stored.id);
		assert.equal(identity.tenantId, stored.tenantId);
		const session = createSessionToken(identity, config);
		const request = new Request('https://agent.test/api/runs');
		assert.equal((await authenticateRequestAsync(request, { get: () => session }, config, { identityStore })).authenticated, true);
		assert.match((await authenticateRequestAsync(request, { get: () => session }, config, { identityStore: { get: async () => ({ ...stored, status: 'revoked' }) } })).reason, /revoked|changed/i);
	});
	it('binds switched sessions to an exact active organization membership', async () => {
		const homeTenantId = '00000000-0000-4000-8000-000000000001';
		const targetTenantId = '00000000-0000-4000-8000-000000000002';
		const config = { authRequired: true, operatorToken: '', operators: [], allowDirectoryIdentities: true, platformAdmins: [], sessionSecret: 'membership-session-secret-that-is-long-enough' };
		const switched = { authenticated: true, subject: 'alice@example.com', displayName: 'Alice', role: 'viewer', tenantId: targetTenantId, accountTenantId: homeTenantId, tenantName: 'Contoso' };
		const session = createSessionToken(switched, config);
		assert.match(session, /^v3\./);
		const verified = verifySessionToken(session, config);
		assert.equal(verified.accountTenantId, homeTenantId);
		assert.equal(verified.tenantId, targetTenantId);
		let requested;
		const activeStore = { resolveMembership: async (...args) => { requested = args; return { id: switched.subject, displayName: switched.displayName, role: switched.role, status: 'active', tenantStatus: 'active', tenantId: targetTenantId, accountTenantId: homeTenantId, tenantName: switched.tenantName }; } };
		assert.equal((await authenticateRequestAsync(new Request('https://agent.test/'), { get: () => session }, config, { identityStore: activeStore })).authenticated, true);
		assert.deepEqual(requested.slice(0, 3), [homeTenantId, switched.subject, targetTenantId]);
		const revokedStore = { resolveMembership: async () => undefined };
		assert.match((await authenticateRequestAsync(new Request('https://agent.test/'), { get: () => session }, config, { identityStore: revokedStore })).reason, /revoked|changed/i);
		assert.equal(authorizeRequest(switched, '/api/auth/organization', 'POST').allowed, true);
	});
	it('immediately rejects durable tokens, configured tokens, and sessions for suspended organizations', async () => {
		const tenantId = '00000000-0000-4000-8000-000000000002';
		const token = 'named-'.padEnd(40, 'n');
		const digest = '3a09af66b1e9ee92e8c170cb3363ccd1c76f84807ecc74ec704ea06f412864d8';
		const config = securityConfig({ KCEV_AUTH_REQUIRED: 'true', SUPABASE_TENANT_ID: tenantId, KCEV_OPERATORS_JSON: JSON.stringify([{ id: 'admin@example.com', name: 'Admin', role: 'admin', tokenSha256: digest, tenantId }]), KCEV_SESSION_SECRET: 'suspended-session-secret-that-is-long-enough' });
		const configured = authenticateCredential(token, config);
		const suspendedStore = {
			tenantStatus: async () => ({ id: tenantId, name: 'Contoso', status: 'suspended' }),
			findByTokenSha256: async () => ({ id: 'durable@example.com', displayName: 'Durable', role: 'admin', status: 'active', tenantStatus: 'suspended', tenantId, tenantName: 'Contoso' }),
			get: async () => ({ id: 'admin@example.com', displayName: 'Admin', role: 'admin', status: 'active', tenantStatus: 'suspended', tenantId, tenantName: 'Contoso' })
		};
		assert.match((await authenticateCredentialAsync(token, config, suspendedStore)).reason, /suspended/i);
		assert.equal((await authenticateCredentialAsync('directory-'.padEnd(40, 'd'), { ...config, operators: [] }, suspendedStore)).authenticated, false);
		const session = createSessionToken(configured, config);
		assert.match((await authenticateRequestAsync(new Request('https://agent.test/api/runs'), { get: () => session }, config, { identityStore: suspendedStore })).reason, /suspended/i);
		const bootstrapToken = 'bootstrap-'.padEnd(40, 'b');
		const bootstrapConfig = { ...config, operatorToken: bootstrapToken, operators: [] };
		const bootstrap = authenticateCredential(bootstrapToken, bootstrapConfig);
		assert.match((await authenticateCredentialAsync(bootstrapToken, bootstrapConfig, suspendedStore)).reason, /suspended/i);
		const bootstrapSession = createSessionToken(bootstrap, bootstrapConfig);
		assert.match((await authenticateRequestAsync(new Request('https://agent.test/settings'), { get: () => bootstrapSession }, bootstrapConfig, { identityStore: suspendedStore })).reason, /suspended/i);
	});
	it('binds configured identities and sessions to exactly one tenant', () => {
		const token = 'tenant-bound-'.padEnd(40, 't');
		const digest = 'e4fe14157cae3fa2d83b313d5746a8ab9c6bc5126c7d3179dc5d23a338b9e1ea';
		const config = securityConfig({ KCEV_AUTH_REQUIRED: 'true', SUPABASE_TENANT_ID: '00000000-0000-4000-8000-000000000001', KCEV_OPERATORS_JSON: JSON.stringify([{ id: 'admin@example.com', role: 'admin', tokenSha256: digest, tenantId: '00000000-0000-4000-8000-000000000001', tenantName: 'Northwind' }]), KCEV_SESSION_SECRET: 'tenant-session-secret-that-is-long-enough' });
		const member = authenticateCredential(token, config);
		assert.equal(member.tenantId, '00000000-0000-4000-8000-000000000001');
		assert.equal(member.tenantName, 'Northwind');
		const session = createSessionToken(member, config);
		assert.equal(verifySessionToken(session, config).tenantId, member.tenantId);
		const otherTenant = { ...config, operators: config.operators.map((operator) => ({ ...operator, tenantId: '00000000-0000-4000-8000-000000000002' })) };
		assert.match(verifySessionToken(session, otherTenant).reason, /revoked|changed/i);
	});
	it('rejects ambiguous static credentials reused across organizations', () => {
		const token = 'ambiguous-'.padEnd(40, 'a');
		const digest = 'db1cc03b34ed52940ca9f2e99b7f1fdc2d40d9d010cfd1ea52950a62e5583f32';
		const operators = [
			{ id: 'northwind-admin', role: 'admin', tokenSha256: digest, tenantId: '00000000-0000-4000-8000-000000000001' },
			{ id: 'contoso-admin', role: 'admin', tokenSha256: digest, tenantId: '00000000-0000-4000-8000-000000000002' }
		];
		const config = securityConfig({ KCEV_AUTH_REQUIRED: 'true', KCEV_OPERATORS_JSON: JSON.stringify(operators) });
		assert.equal(config.operators.length, 0);
		assert.equal(authenticateCredential(token, config).authenticated, false);
	});
	it('separates platform administration from tenant administration and revokes it on allowlist change', async () => {
		const tenantAdmin = { authenticated: true, subject: 'tenant-admin@example.com', role: 'admin', tenantId: '00000000-0000-4000-8000-000000000001', tenantName: 'Northwind', platformAdmin: false };
		assert.equal(authorizeRequest(tenantAdmin, '/api/admin/identities', 'POST').allowed, true);
		assert.equal(authorizeRequest(tenantAdmin, '/api/platform/organizations', 'POST').allowed, false);
		const config = { authRequired: true, operatorToken: '', operators: [], platformAdmins: [tenantAdmin.subject], allowDirectoryIdentities: true, sessionSecret: 'platform-session-secret-that-is-long-enough' };
		const session = createSessionToken(tenantAdmin, config);
		const elevated = verifySessionToken(session, config);
		assert.equal(elevated.platformAdmin, true);
		assert.equal(authorizeRequest(elevated, '/api/platform/organizations', 'POST').allowed, true);
		assert.match(verifySessionToken(session, { ...config, platformAdmins: [] }).reason, /revoked|changed/i);
	});
	it('rejects cross-origin state changes', () => {
		const request = new Request('https://agent.test/api/runs', { method: 'POST', headers: { origin: 'https://evil.test' } });
		assert.equal(validateOrigin(request, new URL(request.url), { trustedOrigins: [] }), false);
	});
	it('enforces bounded request rates', () => {
		assert.equal(consumeRateLimit('unique-rate-test', 2, 1).allowed, true);
		assert.equal(consumeRateLimit('unique-rate-test', 2, 2).allowed, true);
		assert.equal(consumeRateLimit('unique-rate-test', 2, 3).allowed, false);
	});
	it('uses shared rate limiting and fails closed in production', async () => {
		const store = { consume: async (key, limit) => ({ allowed: key === 'known', remaining: limit - 1, resetAt: 60_000, backend: 'supabase-postgres' }) };
		assert.equal((await consumeRateLimitAsync('known', 10, { store, production: true })).backend, 'supabase-postgres');
		await assert.rejects(() => consumeRateLimitAsync('unknown', 10, { store: null, production: true }), /required in production/i);
		assert.equal((await consumeRateLimitAsync('local-only', 10, { store: null, production: false, now: 1 })).backend, 'process-memory');
	});
});
