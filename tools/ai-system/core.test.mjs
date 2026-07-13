/** Contract tests for deterministic complexity classification and approval escalation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessComplexity, loadManifest, loadMcpRegistry, selectPolicies } from './core.mjs';

test('isolated file change is low complexity', () => {
	assert.equal(assessComplexity({ request: 'change heading text', files: ['src/page.html'] }).level, 0);
});

test('integration change is structural', () => {
	assert.equal(assessComplexity({ request: 'add a new API integration dependency', files: ['package.json', 'src/api.ts'] }).level, 2);
});

test('security change requires critical safeguards without approval gating', () => {
	const result = assessComplexity({ request: 'change OAuth authentication', files: ['src/auth.ts'] });
	assert.equal(result.level, 3);
	assert.equal(result.approval_required, false);
});

test('database UI task selects only applicable conditional policies', () => {
	const policies = selectPolicies({ request: 'Fix the responsive user table and its RLS policy', files: ['src/routes/users/+page.svelte', 'db/schema.sql'] });
	assert.ok(policies.includes('.ai/policies/debugging.md'));
	assert.ok(policies.includes('.ai/policies/database.md'));
	assert.ok(policies.includes('.ai/policies/ui.md'));
	assert.ok(policies.includes('.ai/policies/frameworks/sveltekit.md'));
});

test('backend-neutral task does not load framework policy', () => {
	const policies = selectPolicies({ request: 'rename a Go utility', files: ['internal/name.go'] });
	assert.ok(!policies.includes('.ai/policies/frameworks/sveltekit.md'));
});

test('canonical YAML files satisfy validated schemas', async () => {
	const manifest = await loadManifest();
	assert.equal(manifest.version, 1);
	assert.equal((await loadMcpRegistry(manifest)).version, 1);
});

test('protected paths force critical classification', () => {
	for (const file of ['src/auth/session.ts', 'auth/session.ts', '.env.local']) {
		const result = assessComplexity({ request: 'small edit', files: [file] });
		assert.equal(result.level, 3, file);
		assert.equal(result.approval_required, false, file);
	}
});
