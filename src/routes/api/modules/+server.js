import { json } from '@sveltejs/kit';
import { listModuleReadiness } from '$lib/agent/moduleRegistry.server.js';

export function GET() {
	return json({ modules: listModuleReadiness() });
}
