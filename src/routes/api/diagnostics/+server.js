import { json } from '@sveltejs/kit';
import { collectDiagnostics } from '$lib/agent/diagnostics.server.js';

export async function GET() {
	const diagnostics = await collectDiagnostics();
	return json({ diagnostics }, { status: diagnostics.status === 'ready' ? 200 : 503 });
}
