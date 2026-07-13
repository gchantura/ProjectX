import { json } from '@sveltejs/kit';
import { runMaintenanceAutomation } from '$lib/agent/automation.server.js';

export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	const report = await runMaintenanceAutomation(body);
	return json({ report }, { status: report.status === 'completed_with_failures' ? 503 : 200 });
}
