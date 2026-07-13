import { listProviderReadiness } from '$lib/agent/providerRegistry.server.js';
import { collectDiagnostics } from '$lib/agent/diagnostics.server.js';
import { listProjects } from '$lib/agent/projectStore.server.js';

export async function load() {
	const allProviders = await listProviderReadiness();
	const providers = allProviders.filter((provider) => provider.id !== 'deterministic-local');
	const diagnostics = await collectDiagnostics();
	let projects = [];
	let storageError = '';
	try { projects = await listProjects(); }
	catch (error) { storageError = String(error?.message ?? 'Unable to query Supabase projects.'); }
	return {
		projects,
		storageError,
		providers,
		diagnostics
	};
}
