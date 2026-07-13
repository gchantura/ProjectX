const TOOL_CAPABILITIES = Object.freeze({
	analyze: Object.freeze(['list_workspace', 'search_workspace', 'inspect_context', 'inspect_diff', 'analyze_impact']),
	propose: Object.freeze(['list_workspace', 'search_workspace', 'inspect_context', 'inspect_diff', 'analyze_impact', 'write_artifact']),
	execute: Object.freeze(['list_workspace', 'search_workspace', 'inspect_context', 'inspect_diff', 'analyze_impact', 'write_artifact', 'write_source', 'edit_source', 'run_validation', 'rollback_checkpoint'])
});

export function normalizeAutonomyMode(value) {
	const mode = String(value ?? 'execute').trim().toLowerCase();
	return Object.hasOwn(TOOL_CAPABILITIES, mode) ? mode : 'execute';
}

export function toolsForAutonomy(value) {
	return TOOL_CAPABILITIES[normalizeAutonomyMode(value)];
}

export function isToolAllowedForAutonomy(tool, value) {
	return toolsForAutonomy(value).includes(String(tool ?? ''));
}

export function autonomyDescription(value) {
	const mode = normalizeAutonomyMode(value);
	if (mode === 'analyze') return 'Read-only repository analysis; no files or artifacts may be written.';
	if (mode === 'propose') return 'Read repository state and write review artifacts; source files remain immutable.';
	return 'Execute approved repository changes and validations within project policy.';
}
