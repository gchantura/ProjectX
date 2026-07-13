import { rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createApprovedSourceWrite,
	getSourceWriteApprovalPhrase
} from './sourceWrite.server.js';

const testPath = 'docs/approved-source-write-test.md';

test.afterEach(async () => {
	await rm(testPath, { force: true });
});

test('creates an approved source write with audit evidence', async () => {
	const result = await createApprovedSourceWrite({
		path: testPath,
		content: '# Approved source write\n',
		reason: 'Verify the source write approval flow.',
		approvalPhrase: getSourceWriteApprovalPhrase()
	});

	assert.match(result.approval.id, /^approval-/);
	assert.equal(result.approval.path, testPath);
	assert.equal(result.approval.approved, true);
	assert.ok(result.evidence.includes(`source-write:${testPath}`));
	assert.ok(result.evidence.some((entry) => entry.startsWith('approval:approval-')));
});

test('rejects source writes without the exact approval phrase', async () => {
	await assert.rejects(
		() =>
			createApprovedSourceWrite({
				path: testPath,
				content: '# Missing phrase\n',
				reason: 'Verify missing approval phrase rejection.',
				approvalPhrase: 'approve'
			}),
		/Approval phrase/
	);
});

test('rejects source writes outside approved source roots', async () => {
	await assert.rejects(
		() =>
			createApprovedSourceWrite({
				path: '.kcevagent/not-source.md',
				content: '# Outside roots\n',
				reason: 'Verify source root rejection behavior.',
				approvalPhrase: getSourceWriteApprovalPhrase()
			}, { config: { allowedPaths: ['.'] } }),
		/Source writes must stay inside/
	);
});

test('rejects approval-queue writes outside configured paths', async () => {
	await assert.rejects(() => createApprovedSourceWrite({
		path: testPath,
		content: '# Disallowed by settings\n',
		reason: 'Verify configured path policy is authoritative.',
		approvalPhrase: getSourceWriteApprovalPhrase()
	}, { config: { allowedPaths: ['src/'] } }), /configured allowlist/);
});
