import { json } from '@sveltejs/kit';
import { collectOperationsReport } from '$lib/agent/operationsReport.server.js';

export async function GET({ url }) {
	const limit = url.searchParams.get('limit') ?? undefined;
	const report = await collectOperationsReport({ limit });
	return json({ report }, { status: report.status === 'critical' ? 503 : 200 });
}
