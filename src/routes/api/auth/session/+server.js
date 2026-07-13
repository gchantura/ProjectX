import { json } from '@sveltejs/kit';
import { authenticateCredentialAsync, createSessionToken, securityConfig, sessionCookieOptions } from '$lib/server/security.js';

export async function POST({ request, cookies, url }) {
	const body = await request.json();
	const token = String(body?.token ?? '');
	const config = securityConfig();
	const identity = await authenticateCredentialAsync(token, config);
	if (!identity.authenticated) return json({ error: identity.reason === 'Organization access is suspended.' ? 'This organization is suspended. Contact your platform administrator to restore access.' : 'The access token is invalid.' }, { status: 401 });
	try {
		cookies.set('kcev_session', createSessionToken(identity, config), sessionCookieOptions(url));
	} catch {
		return json({ error: 'Session security is not configured. Set KCEV_SESSION_SECRET to an independent random value of at least 32 characters.' }, { status: 503 });
	}
	return json({ authenticated: true, identity: { name: identity.displayName, role: identity.role, organization: identity.tenantName } });
}

export function DELETE({ cookies, url }) {
	cookies.delete('kcev_session', { ...sessionCookieOptions(url), maxAge: 0 });
	return new Response(null, { status: 204 });
}
