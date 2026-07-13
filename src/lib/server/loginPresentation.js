export function accessPresentation({ security, directoryConfigured, oidcEnabled, production }) {
	const bootstrap = String(security.operatorToken ?? '').length >= 32;
	const named = (security.operators ?? []).length > 0 || directoryConfigured;
	const sessionReady = String(security.sessionSecret ?? '').length >= 32;
	const tokenEnabled = sessionReady && (bootstrap || named);
	return {
		tokenEnabled,
		setupRequired: !tokenEnabled && !oidcEnabled,
		source: named ? 'administrator' : bootstrap ? 'deployment' : 'unavailable',
		production,
		message: named ? 'Use the one-time personal access token issued to you by a KcevAgent tenant administrator.' : bootstrap ? 'For initial setup, use the bootstrap administrator token stored as KCEV_OPERATOR_TOKEN in your deployment secret manager.' : 'No token-based access is ready on this server.'
	};
}
