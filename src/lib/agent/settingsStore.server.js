import { defaultAgentConfig } from './runtime.js';
import { createSupabaseProjectStore, isSupabaseTestMode } from './supabaseStore.server.js';

const DEFAULT_SETTINGS = {
	provider: defaultAgentConfig.provider,
	model: defaultAgentConfig.model,
	domain: defaultAgentConfig.domain,
	stepCeiling: defaultAgentConfig.stepCeiling,
	costCeilingUsd: defaultAgentConfig.costCeilingUsd,
	maxTokensPerRun: defaultAgentConfig.maxTokensPerRun,
	allowedPaths: ['src/', 'docs/', 'static/', 'tools/', 'PROJECT_MAP.md', 'package.json', 'package-lock.json', 'README.md'],
	networkAllowlist: [],
	requireApprovalForSourceWrites: true,
	planningMode: 'multi-hypothesis'
};

export async function getAgentSettings({ projectId } = {}) {
	const id = settingsProjectId(projectId);
	const project = await createSupabaseProjectStore().get(id);
	if (!project && isSupabaseTestMode()) return normalizeAgentSettings({});
	if (!project) throw Object.assign(new Error('The selected project does not exist in Supabase.'), { status: 404 });
	return normalizeAgentSettings(project.metadata?.settings ?? {});
}

export async function saveAgentSettings(input = {}, { projectId } = {}) {
	const id = settingsProjectId(projectId);
	const settings = normalizeAgentSettings(input);
	await createSupabaseProjectStore().saveSettings(id, settings);
	return settings;
}

export function normalizeAgentSettings(input = {}) {
	return {
		...DEFAULT_SETTINGS,
		provider: normalizeId(input.provider, DEFAULT_SETTINGS.provider),
		model: normalizeModel(input.model, DEFAULT_SETTINGS.model),
		domain: normalizeId(input.domain, DEFAULT_SETTINGS.domain),
		stepCeiling: clampNumber(input.stepCeiling ?? DEFAULT_SETTINGS.stepCeiling, 1, 12),
		costCeilingUsd: clampNumber(input.costCeilingUsd ?? DEFAULT_SETTINGS.costCeilingUsd, 0, 100),
		maxTokensPerRun: clampNumber(input.maxTokensPerRun ?? DEFAULT_SETTINGS.maxTokensPerRun, 1000, 2000000),
		allowedPaths: normalizeList(input.allowedPaths, DEFAULT_SETTINGS.allowedPaths, normalizePath),
		networkAllowlist: normalizeList(input.networkAllowlist, [], normalizeHostname),
		requireApprovalForSourceWrites: true,
		planningMode: ['single', 'multi-hypothesis'].includes(input.planningMode) ? input.planningMode : DEFAULT_SETTINGS.planningMode
	};
}

export function settingsToRunConfig(settings) {
	const normalized = normalizeAgentSettings(settings);
	return {
		provider: normalized.provider,
		model: normalized.model,
		domain: normalized.domain,
		stepCeiling: normalized.stepCeiling,
		costCeilingUsd: normalized.costCeilingUsd,
		maxTokensPerRun: normalized.maxTokensPerRun,
		allowedPaths: normalized.allowedPaths,
		networkAllowlist: normalized.networkAllowlist,
		requireApprovalForSourceWrites: normalized.requireApprovalForSourceWrites,
		workspaceScope: normalized.allowedPaths.join(', '),
		planningMode: normalized.planningMode
	};
}

function normalizeId(value, fallback) {
	const text = String(value ?? fallback).trim();
	return /^[a-z0-9-]+$/i.test(text) ? text : fallback;
}

function normalizeModel(value, fallback) {
	const text = String(value ?? fallback).trim();
	return /^[a-z0-9._:-]+$/i.test(text) ? text : fallback;
}

function normalizeList(value, fallback, mapper) {
	const source = Array.isArray(value)
		? value
		: String(value ?? '')
				.split(/\r?\n|,/)
				.map((item) => item.trim());
	const normalized = [...new Set(source.map(mapper).filter(Boolean))];
	return normalized.length > 0 ? normalized.slice(0, 24) : fallback;
}

function normalizePath(value) {
	const text = String(value ?? '').trim().replaceAll('\\', '/');
	if (!text || text.includes('..') || text.startsWith('/') || /^[a-z]:\//i.test(text)) return undefined;
	return text.endsWith('/') || text.includes('.') ? text : `${text}/`;
}

function normalizeHostname(value) {
	const text = String(value ?? '').trim().toLowerCase();
	if (!text) return undefined;
	try {
		const url = text.includes('://') ? new URL(text) : new URL(`https://${text}`);
		return /^[a-z0-9.-]+$/i.test(url.hostname) ? url.hostname : undefined;
	} catch {
		return undefined;
	}
}

function normalizeProjectId(value) {
	const text = String(value ?? '').trim();
	if (!/^project-[a-z0-9-]+$/i.test(text)) throw Object.assign(new Error('A valid project id is required for project settings.'), { status: 400 });
	return text;
}

function settingsProjectId(value) {
	if (value == null && isSupabaseTestMode()) return 'project-test-default';
	return normalizeProjectId(value);
}

function clampNumber(value, min, max) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return min;
	return Math.min(Math.max(numeric, min), max);
}
