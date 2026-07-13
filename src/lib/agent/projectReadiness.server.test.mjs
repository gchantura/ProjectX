import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectProjectReadiness } from './projectReadiness.server.js';

test('reports repository and automation readiness for a registered project', async () => {
	const readiness = await collectProjectReadiness('project-ready', {
		resolveProjectContext: async () => ({ projectId: 'project-ready', projectName: 'Ready Project', workspaceRoot: '/workspace/ready' }),
		execGit: async (_cwd, args) => {
			const command = args.join(' ');
			if (command === 'rev-parse --show-toplevel') return { ok: true, stdout: '/workspace\n' };
			if (command === 'branch --show-current') return { ok: true, stdout: 'main\n' };
			if (command === 'rev-parse --short=12 HEAD') return { ok: true, stdout: 'abcdef123456\n' };
			if (command === 'status --porcelain') return { ok: true, stdout: '' };
			return { ok: false, stdout: '' };
		},
		readPackage: async () => ({ name: 'ready-project', scripts: { build: 'vite build', 'ai:test': 'node --test', dev: 'vite dev' } })
	});

	assert.equal(readiness.status, 'ready');
	assert.equal(readiness.repository.branch, 'main');
	assert.equal(readiness.repository.commit, 'abcdef123456');
	assert.deepEqual(readiness.automation.qualityGates, ['ai:test', 'build']);
});

test('surfaces warnings without blocking when the workspace is not indexed', async () => {
	const readiness = await collectProjectReadiness('project-local', {
		resolveProjectContext: async () => ({ projectId: 'project-local', projectName: 'Local Project', workspaceRoot: '/workspace/local' }),
		execGit: async () => ({ ok: false, stdout: '' }),
		readPackage: async () => undefined
	});

	assert.equal(readiness.status, 'warning');
	assert.equal(readiness.repository.status, 'not_indexed');
	assert.match(readiness.warnings.join('\n'), /not inside a Git repository/);
	assert.match(readiness.warnings.join('\n'), /No package\.json/);
});
