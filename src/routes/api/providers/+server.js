import { json } from '@sveltejs/kit';
import {
	listProviderReadiness,
	runProviderReadinessProbe
} from '$lib/agent/providerRegistry.server.js';

export async function GET() {
	const providers = await listProviderReadiness();
	return json({ providers });
}

export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	const providerId = String(body.providerId ?? '').trim();
	const model = String(body.model ?? '').trim() || undefined;
	const provider = await runProviderReadinessProbe(providerId, { model });

	if (!provider) {
		return new Response(`Unknown provider: ${providerId}`, { status: 404 });
	}

	return json({ provider });
}
