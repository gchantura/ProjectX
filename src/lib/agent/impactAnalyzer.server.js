import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.svelte']);
const IGNORE = new Set(['.git', '.kcevagent', '.svelte-kit', 'build', 'dist', 'node_modules']);

export async function analyzeChangeImpact(targetPath, { root = process.cwd(), maxFiles = 2500 } = {}) {
	const target = normalizeRelative(targetPath, root);
	const files = await collectCodeFiles(root, maxFiles);
	if (!files.includes(target)) throw new Error(`Impact target is not a workspace code file: ${target}`);
	const imports = new Map();
	for (const file of files) imports.set(file, await extractImports(file, root, files));
	const reverse = reverseGraph(imports);
	const dependencies = [...(imports.get(target) ?? [])].sort();
	const dependents = traverse(reverse, target, 4);
	const affectedTests = [...new Set([target, ...dependents].filter(isTestFile))].sort();
	const affectedRoutes = [...new Set([target, ...dependents].filter((file) => file.startsWith('src/routes/')))].sort();
	const riskScore = Math.min(100, dependencies.length * 3 + dependents.length * 8 + affectedRoutes.length * 12 + (target.includes('server') ? 10 : 0));
	return {
		target, dependencies, dependents, affectedTests, affectedRoutes, riskScore,
		riskLevel: riskScore >= 60 ? 'high' : riskScore >= 25 ? 'medium' : 'low',
		recommendedValidations: recommendValidations({ target, affectedTests, affectedRoutes, riskScore })
	};
}

export function formatImpactReport(impact) {
	return JSON.stringify(impact, null, 2);
}

async function collectCodeFiles(root, limit) {
	const files = [];
	async function visit(directory) {
		if (files.length >= limit) return;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (files.length >= limit) break;
			if (entry.isDirectory() && IGNORE.has(entry.name)) continue;
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) await visit(absolute);
			else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(toPosix(path.relative(root, absolute)));
		}
	}
	await visit(root);
	return files.sort();
}

async function extractImports(file, root, knownFiles) {
	const content = await readFile(path.join(root, file), 'utf8');
	const specifiers = [...content.matchAll(/(?:from\s*|import\s*\(|import\s+|require\s*\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
	return new Set(specifiers.map((specifier) => resolveSpecifier(file, specifier, knownFiles)).filter(Boolean));
}

function resolveSpecifier(importer, specifier, knownFiles) {
	let base;
	if (specifier.startsWith('$lib/')) base = `src/lib/${specifier.slice(5)}`;
	else if (specifier.startsWith('.')) base = toPosix(path.normalize(path.join(path.dirname(importer), specifier)));
	else return undefined;
	const candidates = [base, ...[...CODE_EXTENSIONS].map((extension) => `${base}${extension}`), ...[...CODE_EXTENSIONS].map((extension) => `${base}/index${extension}`)];
	return candidates.find((candidate) => knownFiles.includes(candidate));
}

function reverseGraph(graph) {
	const reverse = new Map();
	for (const [source, targets] of graph) for (const target of targets) { if (!reverse.has(target)) reverse.set(target, new Set()); reverse.get(target).add(source); }
	return reverse;
}

function traverse(graph, start, maxDepth) {
	const visited = new Set();
	let frontier = [start];
	for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
		const next = [];
		for (const node of frontier) for (const neighbor of graph.get(node) ?? []) if (!visited.has(neighbor) && neighbor !== start) { visited.add(neighbor); next.push(neighbor); }
		frontier = next;
	}
	return [...visited].sort();
}

function recommendValidations({ target, affectedTests, affectedRoutes, riskScore }) {
	const commands = ['npm run ai:check'];
	if (affectedTests.length || riskScore >= 25) commands.push('npm run ai:test');
	if (affectedRoutes.length || target.endsWith('.svelte') || riskScore >= 60) commands.push('npm run build');
	return commands;
}
function normalizeRelative(value, root) { const absolute = path.resolve(root, String(value ?? '')); const relative = path.relative(root, absolute); if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Impact target must stay inside the workspace.'); return toPosix(relative); }
function isTestFile(file) { return /(?:\.test\.|\.spec\.|\/tests?\/)/i.test(file); }
function toPosix(value) { return value.replaceAll('\\', '/'); }
