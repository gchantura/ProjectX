import { createTenantIdentityLifecycleStore } from './identityLifecycleStore.server.js';
import { scimError } from './scimProtocol.js';

export function scimStore(locals) {
	const store = createTenantIdentityLifecycleStore(locals.identity.tenantId);
	if (!store) throw Object.assign(new Error('SCIM provisioning is not configured.'), { status: 503 });
	return store;
}

export function scimJson(body, { status = 200, headers = {} } = {}) {
	return new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/scim+json', 'cache-control': 'no-store', ...headers } });
}

export function scimFailure(error) {
	const failure = scimError(error);
	return scimJson(failure.body, { status: failure.status });
}
