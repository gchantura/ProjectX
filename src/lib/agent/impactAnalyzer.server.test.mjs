import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { analyzeChangeImpact } from './impactAnalyzer.server.js';

let root;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

describe('change impact intelligence', () => {
	it('traces transitive dependents, routes, tests, and validation needs', async () => {
		root = await mkdtemp(path.join(tmpdir(), 'kcev-impact-'));
		await mkdir(path.join(root, 'src/lib'), { recursive: true });
		await mkdir(path.join(root, 'src/routes'), { recursive: true });
		await writeFile(path.join(root, 'src/lib/core.js'), 'export const core = 1;');
		await writeFile(path.join(root, 'src/lib/service.js'), "import { core } from './core.js'; export { core };");
		await writeFile(path.join(root, 'src/routes/+page.js'), "import { core } from '$lib/service.js'; export { core };");
		await writeFile(path.join(root, 'src/lib/service.test.mjs'), "import './service.js';");
		const impact = await analyzeChangeImpact('src/lib/core.js', { root });
		assert.deepEqual(impact.dependents, ['src/lib/service.js', 'src/lib/service.test.mjs', 'src/routes/+page.js']);
		assert.deepEqual(impact.affectedRoutes, ['src/routes/+page.js']);
		assert.deepEqual(impact.affectedTests, ['src/lib/service.test.mjs']);
		assert.ok(impact.recommendedValidations.includes('npm run build'));
	});
	it('rejects targets outside the workspace', async () => {
		root = await mkdtemp(path.join(tmpdir(), 'kcev-impact-'));
		await assert.rejects(() => analyzeChangeImpact('../escape.js', { root }), /inside the workspace/);
	});
});
