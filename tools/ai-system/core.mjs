/** Canonical framework-neutral AI context engine: index, complexity, adapters, synchronization, and validation. */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import YAML from 'yaml';
import { z } from 'zod';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, '.ai/manifest.yaml');
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.svelte', '.vue', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.css', '.scss', '.html', '.md', '.json', '.yaml', '.yml', '.toml', '.sql', '.sh', '.ps1']);

const normalize = (value) => value.replaceAll('\\', '/');
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const RelativePath = z.string().min(1).refine((value) => !path.isAbsolute(value) && !normalize(value).split('/').includes('..'), 'Must be a project-relative path');
const ManifestSchema = z.object({
	version: z.literal(1),
	project: z.object({ name: z.string().min(1), description: z.string(), source_roots: z.array(RelativePath).min(1), exclude: z.array(RelativePath) }),
	context: z.object({ canonical_entry: RelativePath, architecture: RelativePath, decisions: RelativePath, generated_map: RelativePath, human_map: RelativePath }),
	adapters: z.array(RelativePath).min(1),
	skills: z.object({ canonical: RelativePath, adapters: z.array(RelativePath) }),
	integrations: z.object({ mcp_registry: RelativePath, generated_config: RelativePath }),
	quality: z.object({ commands: z.record(z.string(), z.string()), require_clean_context: z.boolean() }),
	complexity: z.object({
		default_on_uncertainty: z.literal('higher'), approval_level: z.union([z.literal(3), z.null()]),
		thresholds: z.object({ trivial: z.number().int(), local: z.number().int(), structural: z.number().int() }),
		protected_paths: z.array(z.string().min(1)).default([])
	})
});
const McpRegistrySchema = z.object({
	version: z.literal(1),
	servers: z.record(z.string(), z.object({
		enabled: z.boolean(), trust: z.enum(['local', 'official', 'community']), provider: z.string().min(1), description: z.string().min(1),
		command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).optional()
	}))
});

export async function loadManifest() {
	return ManifestSchema.parse(YAML.parse(await readFile(MANIFEST_PATH, 'utf8')));
}

export async function loadMcpRegistry(manifest) {
	manifest ??= await loadManifest();
	return McpRegistrySchema.parse(YAML.parse(await readFile(path.join(ROOT, manifest.integrations.mcp_registry), 'utf8')));
}

async function walk(absolute, excluded) {
	const entries = await readdir(absolute, { withFileTypes: true });
	const output = [];
	for (const entry of entries) {
		const target = path.join(absolute, entry.name);
		const relative = normalize(path.relative(ROOT, target));
		if (excluded.some((item) => relative === item || relative.startsWith(`${item}/`))) continue;
		if (entry.isDirectory()) output.push(...await walk(target, excluded));
		else output.push(target);
	}
	return output;
}

function analyzeText(relative, content) {
	const extension = path.extname(relative).toLowerCase();
	const imports = new Set();
	const exports = new Set();
	const script = extension === '.svelte' ? [...content.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join('\n') : content;
	if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.svelte'].includes(extension)) {
		for (const imported of ts.preProcessFile(script, true, true).importedFiles) imports.add(imported.fileName);
	} else {
		for (const match of content.matchAll(/(?:import[\s\S]*?from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) imports.add(match[1]);
	}
	for (const match of content.matchAll(/export\s+(?:default\s+)?(?:class|function|const|let|var)?\s*([\w$]+)?/g)) exports.add(match[1] || 'default');
	return {
		extension: extension || '[none]',
		imports: [...imports].sort(),
		exports: [...exports].sort(),
		is_test: /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\./i.test(relative),
		is_generated: /(?:^|\/)(?:generated|dist|build)(?:\/|$)/i.test(relative),
		analysis: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.svelte'].includes(extension) ? 'typescript-preprocess' : 'lightweight-patterns'
	};
}

export async function buildIndex() {
	const manifest = await loadManifest();
	const excluded = manifest.project.exclude.map(normalize);
	const roots = manifest.project.source_roots.map((item) => path.join(ROOT, item));
	const files = [];
	for (const sourceRoot of roots) {
		try {
			for (const absolute of await walk(sourceRoot, excluded)) {
				const relative = normalize(path.relative(ROOT, absolute));
				const info = await stat(absolute);
				const extension = path.extname(relative).toLowerCase();
				const content = TEXT_EXTENSIONS.has(extension) && info.size < 1_000_000 ? await readFile(absolute, 'utf8') : '';
				files.push({ path: relative, bytes: info.size, digest: hash(content || `${info.size}`), ...analyzeText(relative, content) });
			}
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	const packageFile = path.join(ROOT, 'package.json');
	let packageInfo = null;
	try {
		const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
		packageInfo = { name: pkg.name, version: pkg.version, scripts: pkg.scripts ?? {}, dependencies: { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } };
	} catch {}
	return {
		_generated: 'GENERATED FILE. DO NOT EDIT MANUALLY. Run npm run ai:sync.',
		schema_version: 1,
		index_kind: 'navigation',
		limitations: 'This is a navigation index, not complete architecture or semantic code intelligence.',
		project: manifest.project, package: packageInfo, source_digest: hash(JSON.stringify(files)), files
	};
}

function globMatches(relative, glob) {
	let pattern = normalize(glob);
	const anyParent = pattern.startsWith('**/');
	if (anyParent) pattern = pattern.slice(3);
	const expression = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '§§').replaceAll('*', '[^/]*').replaceAll('§§', '.*');
	return new RegExp(`^${anyParent ? '(?:.*/)?' : ''}${expression}$`, 'i').test(normalize(relative));
}

export function assessComplexity({ request = '', files = [], protectedPaths = ['.env*', '**/migrations/**', '**/auth/**', '**/payments/**', '**/billing/**', '**/secrets/**'] } = {}) {
	const haystack = `${request} ${files.join(' ')}`.toLowerCase();
	let score = files.length > 5 ? 3 : files.length > 1 ? 2 : files.length === 1 ? 1 : 0;
	const reasons = [];
	const protectedFiles = files.filter((file) => protectedPaths.some((glob) => globMatches(file, glob)));
	if (protectedFiles.length) { score += 9; reasons.push(`protected path: ${protectedFiles.join(', ')}`); }
	const rules = [
		[/(auth|permission|oauth|secret|credential|payment|billing|security)/, 9, 'security or trust boundary'],
		[/(migration|schema|database|sql|destructive|delete data|drop table)/, 9, 'data or destructive change'],
		[/(dependency|package\.json|lockfile|integration|mcp|api contract)/, 3, 'dependency or integration boundary'],
		[/(architecture|refactor|shared api|public api|cross-cutting)/, 3, 'architectural scope'],
		[/(deploy|production|infrastructure|ci\/cd)/, 4, 'deployment impact']
	];
	for (const [pattern, points, reason] of rules) if (pattern.test(haystack)) { score += points; reasons.push(reason); }
	if (files.length > 1) reasons.push(`${files.length} files affected`);
	const level = score <= 1 ? 0 : score <= 4 ? 1 : score <= 8 ? 2 : 3;
	const actions = level === 0 ? ['implement', 'targeted validation']
		: level === 1 ? ['short impact check', 'implement', 'relevant tests']
		: level === 2 ? ['write plan', 'analyze boundaries', 'implement', 'full relevant validation', 'update ADR if architecture changes']
		: ['write plan and impact analysis', 'document rollback strategy', 'perform enhanced validation'];
	return { level, label: ['trivial', 'local', 'structural', 'critical'][level], score, reasons: reasons.length ? reasons : ['isolated low-risk change'], actions, approval_required: false };
}

export function selectPolicies({ request = '', files = [] } = {}) {
	const context = `${request} ${files.join(' ')}`.toLowerCase();
	const policies = new Set([
		'.ai/policies/workflow.md',
		'.ai/policies/complexity.md',
		'.ai/policies/quality.md',
		'.ai/policies/security.md',
		'.ai/policies/design.md',
		'.ai/policies/hygiene.md'
	]);
	if (/(error|bug|debug|fail|exception|stack trace|regression|fix)/.test(context)) policies.add('.ai/policies/debugging.md');
	if (/(database|schema|sql|migration|table|column|index|rls|supabase|postgres|mysql|sqlite|storage)/.test(context)) policies.add('.ai/policies/database.md');
	if (/(ui|page|component|form|style|css|layout|responsive|mobile|tablet|desktop|accessib|\.svelte|\.vue|\.jsx|\.tsx)/.test(context)) policies.add('.ai/policies/ui.md');
	if (/(svelte|sveltekit|\+page|\+layout|hooks\.server|\.svelte)/.test(context)) policies.add('.ai/policies/frameworks/sveltekit.md');
	return [...policies];
}

function adapterContent(target) {
	const title = target === 'AGENTS.md' ? 'Universal Agent Contract' : `Adapter: ${target}`;
	return `<!-- Generated by tools/ai-system. Do not edit directly. -->\n# ${title}\n\nThis repository's canonical AI policy lives under \`.ai/\`.\n\n1. Read \`.ai/policies/workflow.md\`, \`.ai/policies/complexity.md\`, and \`.ai/architecture/overview.md\`.\n2. Inspect \`PROJECT_MAP.md\` or use the project MCP before opening broad source context.\n3. Assess task complexity before editing; level 3 requires a plan, rollback strategy, and enhanced validation.\n4. Keep changes minimal, preserve architectural boundaries, and never expose secrets.\n5. Run \`npm run ai:sync\` and \`npm run ai:check\` plus task-relevant tests before completion.\n\nGenerated facts: \`.ai/architecture/map.json\`. Skills: \`.ai/skills/\`. Durable decisions: \`.ai/architecture/decisions/\`.\n`;
}

function humanMap(index) {
	const lines = ['<!-- Generated by tools/ai-system. Do not edit directly. -->', '# Project Map', '', `Source digest: \`${index.source_digest}\``, '', '## Project', '', `- Name: ${index.project.name}`, `- Description: ${index.project.description}`, `- Indexed files: ${index.files.length}`, '', '## Files', ''];
	for (const file of index.files) lines.push(`- \`${file.path}\` — ${file.bytes} bytes; imports: ${file.imports.length}; exports: ${file.exports.length}${file.is_test ? '; test' : ''}`);
	lines.push('', 'Use the project MCP `get_file_context` tool to load a file only when needed.', '');
	return lines.join('\n');
}

export async function renderArtifacts() {
	const manifest = await loadManifest();
	const index = await buildIndex();
	const artifacts = new Map();
	artifacts.set(manifest.context.generated_map, `${JSON.stringify(index, null, 2)}\n`);
	artifacts.set(manifest.context.human_map, humanMap(index));
	for (const target of manifest.adapters) artifacts.set(target, adapterContent(target));
	const skill = await readFile(path.join(ROOT, manifest.skills.canonical), 'utf8');
	for (const target of manifest.skills.adapters) artifacts.set(target, skill);
	const registry = await loadMcpRegistry(manifest);
	const mcpServers = Object.fromEntries(Object.entries(registry.servers)
		.filter(([, server]) => server.enabled)
		.map(([name, server]) => [name, { command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) }]));
	artifacts.set(manifest.integrations.generated_config, `${JSON.stringify({ mcpServers }, null, 2)}\n`);
	return artifacts;
}

export async function syncSystem() {
	const artifacts = await renderArtifacts();
	for (const [relative, content] of artifacts) {
		const absolute = path.join(ROOT, relative);
		try { if (await readFile(absolute, 'utf8') === content) continue; } catch {}
		await mkdir(path.dirname(absolute), { recursive: true });
		await writeFile(absolute, content, 'utf8');
	}
	return [...artifacts.keys()];
}

export async function validateSystem() {
	const expected = await renderArtifacts();
	const issues = [];
	for (const [relative, content] of expected) {
		try { if (await readFile(path.join(ROOT, relative), 'utf8') !== content) issues.push(`${relative}: stale`); }
		catch { issues.push(`${relative}: missing`); }
	}
	const manifest = await loadManifest();
	if (manifest.version !== 1) issues.push('.ai/manifest.yaml: unsupported version');
	return issues;
}

export function aiSystemPlugin() {
	return { name: 'ai-system-sync', async buildStart() { await syncSystem(); } };
}
