import { json } from '@sveltejs/kit';
import { createAuditStore } from '$lib/server/auditStore.server.js';

export async function GET() {
	const store = createAuditStore();
	if (!store) return json({ error: 'Security audit ledger is not configured.' }, { status: 503 });
	const [events, verification] = await Promise.all([store.list({ limit: 1000 }), store.verify()]);
	return json({ exportedAt: new Date().toISOString(), verification, events }, { headers: { 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="kcev-security-audit.json"' } });
}
