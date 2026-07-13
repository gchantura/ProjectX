/** Framework-neutral MCP facade for project discovery, complexity assessment, planning, and validation. */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ROOT, assessComplexity, buildIndex, loadManifest, selectPolicies, syncSystem, validateSystem } from './ai-system/core.mjs';

const server = new McpServer({ name: 'universal-project-context', version: '1.0.0' });
const response = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

function safePath(relative) {
	const absolute = path.resolve(ROOT, relative);
	if (absolute !== ROOT && !absolute.startsWith(`${ROOT}${path.sep}`)) throw new Error('Path escapes the project root.');
	return absolute;
}

server.registerResource('project-map', 'project://architecture/map', {
	title: 'Generated project architecture map', mimeType: 'application/json'
}, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await buildIndex(), null, 2) }] }));

server.registerResource('agent-workflow', 'project://policy/workflow', {
	title: 'Canonical agent workflow', mimeType: 'text/markdown'
}, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readFile(safePath('.ai/policies/workflow.md'), 'utf8') }] }));

server.registerTool('understand_project', {
	description: 'Return a compact project overview, source digest, roots, package commands, and architecture entry points.'
}, async () => {
	const [index, overview] = await Promise.all([buildIndex(), readFile(safePath('.ai/architecture/overview.md'), 'utf8')]);
	return response({ project: index.project, source_digest: index.source_digest, file_count: index.files.length, package: index.package, architecture: overview });
});

server.registerTool('find_relevant_files', {
	description: 'Rank likely relevant files by path, imports, exports, and lightweight text matches without returning full files.',
	inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(30).default(10) }
}, async ({ query, limit }) => {
	const tokens = query.toLowerCase().split(/\W+/).filter((item) => item.length > 2);
	const index = await buildIndex();
	const ranked = [];
	for (const file of index.files) {
		let score = tokens.reduce((total, token) => total + (file.path.toLowerCase().includes(token) ? 4 : 0) + (file.imports.join(' ').toLowerCase().includes(token) ? 2 : 0) + (file.exports.join(' ').toLowerCase().includes(token) ? 2 : 0), 0);
		if (score === 0 && file.bytes < 300_000) {
			try { const body = (await readFile(safePath(file.path), 'utf8')).toLowerCase(); score += tokens.reduce((total, token) => total + (body.includes(token) ? 1 : 0), 0); } catch {}
		}
		if (score) ranked.push({ path: file.path, score, imports: file.imports, exports: file.exports });
	}
	return response(ranked.sort((a, b) => b.score - a.score).slice(0, limit));
});

server.registerTool('get_file_context', {
	description: 'Read one project file after locating it through the project index.',
	inputSchema: { path: z.string().min(1) }
}, async ({ path: relative }) => response(await readFile(safePath(relative), 'utf8')));

server.registerTool('get_architecture_decisions', {
	description: 'List durable architecture decisions, optionally returning one decision.',
	inputSchema: { file: z.string().optional() }
}, async ({ file }) => {
	const directory = safePath('.ai/architecture/decisions');
	if (file) return response(await readFile(path.join(directory, path.basename(file)), 'utf8'));
	return response((await readdir(directory)).sort());
});

server.registerTool('assess_complexity', {
	description: 'Deterministically classify task risk and required workflow. Use before edits.',
	inputSchema: { request: z.string(), files: z.array(z.string()).default([]) }
}, async (input) => {
	const manifest = await loadManifest();
	return response(assessComplexity({ ...input, protectedPaths: manifest.complexity.protected_paths }));
});

server.registerTool('get_applicable_policies', {
	description: 'Return the minimal canonical policy set applicable to a request and its likely files.',
	inputSchema: { request: z.string(), files: z.array(z.string()).default([]) }
}, async (input) => response({ policies: selectPolicies(input) }));

server.registerTool('create_change_plan', {
	description: 'Create a process-appropriate plan template from the canonical complexity rubric without modifying files.',
	inputSchema: { request: z.string(), files: z.array(z.string()).default([]) }
}, async (input) => {
	const manifest = await loadManifest();
	const assessment = assessComplexity({ ...input, protectedPaths: manifest.complexity.protected_paths });
	return response({ request: input.request, assessment, plan: assessment.actions.map((action, index) => ({ step: index + 1, action, status: 'pending' })) });
});

server.registerTool('validate_change', {
	description: 'Validate canonical generated context and vendor adapters for staleness.'
}, async () => {
	const issues = await validateSystem();
	return response({ valid: issues.length === 0, issues });
});

server.registerTool('sync_project_context', {
	description: 'Regenerate derived project map and all vendor adapters from canonical sources.'
}, async () => response({ updated: await syncSystem() }));

await loadManifest();
await server.connect(new StdioServerTransport());
