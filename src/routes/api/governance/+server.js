import { json } from '@sveltejs/kit';
import { collectGovernanceReport } from '$lib/agent/governance.server.js';

export async function GET({ url }) {
	const selectedProviderId = url.searchParams.get('provider') ?? undefined;
	const selectedModel = url.searchParams.get('model') ?? undefined;
	const mode = url.searchParams.get('mode') ?? 'interactive';
	const governance = await collectGovernanceReport({ selectedProviderId, selectedModel, mode });
	return json({ governance }, { status: governance.status === 'block' ? 409 : 200 });
}
