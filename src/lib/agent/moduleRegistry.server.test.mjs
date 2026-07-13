import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getModuleReadiness, listModuleReadiness } from './moduleRegistry.server.js';

describe('module registry', () => {
	it('lists the installed coding module', () => {
		const modules = listModuleReadiness();

		assert.equal(modules.length, 1);
		assert.equal(modules[0].id, 'coding');
		assert.equal(modules[0].status, 'installed');
		assert.equal(modules[0].default, true);
	});

	it('summarizes tool risk and approvals', () => {
		const coding = getModuleReadiness('coding');
		const sourceWrite = coding.tools.find((tool) => tool.name === 'write_source');

		assert.equal(coding.toolCount, 9);
		assert.deepEqual(coding.riskSummary, { low: 5, medium: 2, high: 2 });
		assert.equal(coding.tools.find((tool) => tool.name === 'edit_source').approvalRequired, false);
		assert.equal(coding.highestRisk, 'high');
		assert.equal(sourceWrite.approvalRequired, true);
		assert.equal(sourceWrite.access, 'workspace-write');
	});

	it('keeps built-in tools scoped to local workspace effects', () => {
		const coding = getModuleReadiness('coding');

		assert.equal(coding.tools.every((tool) => tool.externalSideEffect === false), true);
		assert.equal(coding.tools.find((tool) => tool.name === 'run_validation').access, 'local-command');
	});

	it('returns null for unknown modules', () => {
		assert.equal(getModuleReadiness('writing'), null);
	});
});
