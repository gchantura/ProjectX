import { createAuditStore } from '$lib/server/auditStore.server.js';

export async function load() {
	const store = createAuditStore();
	if (!store) return { events: [], verification: { valid: false, eventCount: 0, headHash: null }, auditError: 'Configure Supabase and apply the security-audit migration.' };
	try {
		const [events, verification] = await Promise.all([store.list({ limit: 250 }), store.verify()]);
		return { events, verification, auditError: '' };
	} catch { return { events: [], verification: { valid: false, eventCount: 0, headHash: null }, auditError: 'The security audit ledger is unavailable.' }; }
}
