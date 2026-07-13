import { error, json } from '@sveltejs/kit';
import { createRunAuditBundle } from '$lib/agent/auditExport.server.js';

export async function GET({ params }) {
	const bundle = await createRunAuditBundle(params.id);
	if (!bundle) throw error(404, 'Run audit bundle not found.');
	return json({ bundle }, {
		headers: {
			'cache-control': 'no-store',
			'content-disposition': `attachment; filename="${params.id}-audit-bundle.json"`
		}
	});
}
