import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const violations = [];

async function walk(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await walk(path);
		else if (extname(entry.name) === '.css') await inspect(path);
	}
}

async function inspect(path) {
	const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const rule = line.trim();
		if (/#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i.test(rule)) report(path, index, 'raw color', rule);
		if (/\b(?:linear|radial|conic)-gradient\(/i.test(rule)) report(path, index, 'gradient', rule);
		if (/font-size:\s*(?:clamp\(|\d*\.?\d+(?:px|rem|vw))/i.test(rule)) report(path, index, 'raw font size', rule);
		const radius = rule.match(/border-radius:\s*([^;]+)/)?.[1].trim();
		if (radius && !/^var\(--(?:component-radius|radius-)/.test(radius)) report(path, index, 'raw radius', rule);
	}
}

function report(path, index, type, rule) {
	violations.push(`${relative(root, path)}:${index + 1} ${type}: ${rule}`);
}

await walk(root);

if (violations.length) {
	console.error(`Design-token check failed:\n${violations.join('\n')}`);
	process.exit(1);
}

console.log('Design-token check passed.');
