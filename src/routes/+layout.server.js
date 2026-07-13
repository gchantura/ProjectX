import { createIdentityStore } from '$lib/server/identityStore.server.js';

export async function load({ locals }) {
	if (!locals.identity) return { identity: { name: 'Local administrator', role: 'admin', organization: 'Local workspace', memberships: [] } };
	const current = locals.identity;
	let memberships = [{ tenantId: current.tenantId, tenantName: current.tenantName, role: current.role, status: 'active', tenantStatus: 'active' }];
	let accountReference = null;
	const store = createIdentityStore();
	if (store && current.accountTenantId) {
		try {
			const storedMemberships = await store.listMemberships(current.accountTenantId, current.subject);
			if (storedMemberships.length > 0) { memberships = storedMemberships; accountReference = `${current.accountTenantId}:${current.subject}`; }
		}
		catch { /* Migration rollout keeps the current signed organization usable. */ }
	}
	return { identity: { name: current.displayName, subject: current.subject, role: current.role, organization: current.tenantName, tenantId: current.tenantId, accountTenantId: current.accountTenantId ?? current.tenantId, accountReference, memberships } };
}
