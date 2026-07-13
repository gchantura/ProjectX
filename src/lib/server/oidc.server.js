import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'];
const STATE_TTL_SECONDS = 10 * 60;

export function oidcConfig(env = process.env) {
	return oidcConfigFromValues({ issuer: env.KCEV_OIDC_ISSUER, clientId: env.KCEV_OIDC_CLIENT_ID, clientSecret: env.KCEV_OIDC_CLIENT_SECRET, displayName: env.KCEV_OIDC_DISPLAY_NAME, scopes: env.KCEV_OIDC_SCOPES, allowedEndpointOrigins: env.KCEV_OIDC_ALLOWED_ENDPOINT_ORIGINS, source: 'environment', revision: 'environment' });
}

export function oidcConfigFromValues(values = {}) {
	const issuer = normalizeHttps(values.issuer);
	const clientId = String(values.clientId ?? '');
	const clientSecret = String(values.clientSecret ?? '');
	if (!issuer || !clientId || !clientSecret) return null;
	const additionalOrigins = Array.isArray(values.allowedEndpointOrigins) ? values.allowedEndpointOrigins : String(values.allowedEndpointOrigins ?? '').split(',');
	const allowedEndpointOrigins = new Set([new URL(issuer).origin, ...additionalOrigins.map(normalizeOrigin).filter(Boolean)]);
	return { issuer, clientId, clientSecret, displayName: String(values.displayName ?? 'Company SSO').slice(0, 80), scopes: normalizeScopes(values.scopes), allowedEndpointOrigins, source: String(values.source ?? 'runtime'), revision: String(values.revision ?? 'runtime') };
}

export function oidcConfigFingerprint(config) {
	if (!config) return '';
	return createHash('sha256').update(JSON.stringify({ issuer: config.issuer, clientId: config.clientId, source: config.source, revision: config.revision })).digest('hex');
}

export async function discoverOidc(config, fetchImpl = globalThis.fetch) {
	if (!config) throw oidcError('OIDC is not configured.', 503);
	const discoveryUrl = `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
	const response = await fetchImpl(discoveryUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000), redirect: 'error' }).catch((cause) => { throw oidcError('Unable to reach OIDC discovery.', 502, cause); });
	if (!response.ok) throw oidcError('OIDC discovery failed.', 502);
	const metadata = await response.json().catch(() => null);
	if (!metadata || metadata.issuer !== config.issuer) throw oidcError('OIDC discovery issuer mismatch.', 502);
	for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) validateEndpoint(metadata[field], config);
	if (metadata.response_types_supported && !metadata.response_types_supported.includes('code')) throw oidcError('OIDC provider does not support the authorization code flow.', 502);
	if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256')) throw oidcError('OIDC provider does not support PKCE S256.', 502);
	if (metadata.token_endpoint_auth_methods_supported && !metadata.token_endpoint_auth_methods_supported.includes('client_secret_basic')) throw oidcError('OIDC provider does not support client_secret_basic.', 502);
	return metadata;
}

export function createOidcAuthorization({ config, metadata, redirectUri, organization, returnTo = '/', now = new Date() }) {
	if (!validOrganization(organization)) throw oidcError('A valid organization binding is required for OIDC.', 400);
	const state = randomBytes(32).toString('base64url');
	const nonce = randomBytes(32).toString('base64url');
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	const url = new URL(metadata.authorization_endpoint);
	url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri, scope: config.scopes, state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
	return { url: url.toString(), transaction: { state, nonce, verifier, redirectUri, returnTo: safeReturnTo(returnTo), tenantId: organization.id, tenantName: organization.name.slice(0, 160), tenantSlug: organization.slug, oidcConfigFingerprint: oidcConfigFingerprint(config), expiresAt: Math.floor(now.getTime() / 1000) + STATE_TTL_SECONDS } };
}

export function sealOidcTransaction(transaction, secret) {
	if (String(secret ?? '').length < 32) throw oidcError('Session signing is not configured.', 503);
	const payload = Buffer.from(JSON.stringify(transaction)).toString('base64url');
	return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

export function openOidcTransaction(value, secret, now = new Date()) {
	const [payload, signature, extra] = String(value ?? '').split('.');
	if (!payload || !signature || extra || String(secret ?? '').length < 32) throw oidcError('OIDC transaction is missing or invalid.', 400);
	const expected = createHmac('sha256', secret).update(payload).digest('base64url');
	if (!constantTimeEqual(signature, expected)) throw oidcError('OIDC transaction is missing or invalid.', 400);
	let transaction;
	try { transaction = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw oidcError('OIDC transaction is malformed.', 400); }
	if (!transaction.state || !transaction.nonce || !/^[A-Za-z0-9_-]{43,128}$/.test(transaction.verifier ?? '') || !/^[a-f0-9]{64}$/.test(transaction.oidcConfigFingerprint ?? '') || !validOrganization({ id: transaction.tenantId, name: transaction.tenantName, slug: transaction.tenantSlug }) || transaction.expiresAt <= Math.floor(now.getTime() / 1000)) throw oidcError('OIDC transaction expired or invalid.', 400);
	return transaction;
}

export function validateOidcConfigFingerprint(transaction, config) { return constantTimeEqual(transaction?.oidcConfigFingerprint, oidcConfigFingerprint(config)); }

export async function exchangeOidcCode({ config, metadata, code, transaction, fetchImpl = globalThis.fetch }) {
	const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: transaction.redirectUri, code_verifier: transaction.verifier });
	const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
	const response = await fetchImpl(metadata.token_endpoint, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${credentials}` }, body, signal: AbortSignal.timeout(15_000), redirect: 'error' }).catch((cause) => { throw oidcError('Unable to reach the OIDC token endpoint.', 502, cause); });
	const tokens = await response.json().catch(() => ({}));
	if (!response.ok || typeof tokens.id_token !== 'string') throw oidcError('OIDC code exchange failed.', 401);
	return tokens;
}

export async function verifyOidcIdToken({ config, metadata, idToken, nonce, jwks = createRemoteJWKSet(new URL(metadata.jwks_uri)) }) {
	const supported = (metadata.id_token_signing_alg_values_supported ?? ALGORITHMS).filter((algorithm) => ALGORITHMS.includes(algorithm));
	if (!supported.length) throw oidcError('OIDC provider has no accepted ID-token signing algorithm.', 502);
	let payload;
	try { ({ payload } = await jwtVerify(idToken, jwks, { issuer: config.issuer, audience: config.clientId, algorithms: supported, clockTolerance: 30 })); }
	catch (cause) { throw oidcError('OIDC ID token validation failed.', 401, cause); }
	if (!constantTimeEqual(payload.nonce, nonce)) throw oidcError('OIDC nonce validation failed.', 401);
	if (payload.email_verified !== true || typeof payload.email !== 'string') throw oidcError('A verified email claim is required for KcevAgent access.', 403);
	return { issuer: payload.iss, subject: payload.sub, email: payload.email.trim().toLowerCase(), name: String(payload.name ?? payload.email).slice(0, 160) };
}

export function oidcCookieOptions(url) { return { path: '/api/auth/oidc', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: STATE_TTL_SECONDS }; }
export function validateOidcState(returnedState, transaction) { return constantTimeEqual(returnedState, transaction?.state); }

function validateEndpoint(value, config) {
	const normalized = normalizeHttps(value);
	if (!normalized || !config.allowedEndpointOrigins.has(new URL(normalized).origin)) throw oidcError('OIDC metadata contains an untrusted endpoint.', 502);
}
function normalizeHttps(value) { try { const url = new URL(String(value ?? '')); return url.protocol === 'https:' && !url.username && !url.password ? url.toString().replace(/\/$/, '') : null; } catch { return null; } }
function normalizeOrigin(value) { try { const url = new URL(String(value ?? '').trim()); return url.protocol === 'https:' && url.pathname === '/' ? url.origin : null; } catch { return null; } }
function normalizeScopes(value) { const scopes = new Set(String(value ?? 'openid profile email').split(/\s+/).filter((scope) => /^[a-zA-Z0-9._:-]+$/.test(scope))); scopes.add('openid'); scopes.add('email'); return [...scopes].join(' '); }
function safeReturnTo(value) { return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value.slice(0, 500) : '/'; }
function validOrganization(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value?.id ?? '')) && typeof value?.name === 'string' && value.name.length >= 1 && value.name.length <= 160 && /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(String(value?.slug ?? '')); }
function constantTimeEqual(left, right) { const a = Buffer.from(String(left ?? '')); const b = Buffer.from(String(right ?? '')); return a.length === b.length && timingSafeEqual(a, b); }
function oidcError(message, status, cause) { return Object.assign(new Error(message), { status, code: 'OIDC_ERROR', cause }); }
