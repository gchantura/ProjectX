import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import { createProject, getProject, listProjects, resolveProjectContext } from './projectStore.server.js';

let dataDir;
let workspace;

before(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'kcev-project-data-'));
	workspace = await mkdtemp(join(tmpdir(), 'kcev-project-workspace-'));
	process.env.KCEV_AGENT_DATA_DIR = dataDir;
});

after(async () => {
	delete process.env.KCEV_AGENT_DATA_DIR;
	await rm(dataDir, { recursive: true, force: true });
	await rm(workspace, { recursive: true, force: true });
});

test('registers canonical projects and resolves immutable execution context', async () => {
	const project = await createProject({ name: 'Customer Platform', workspaceRoot: workspace });
	assert.match(project.id, /^project-/);
	assert.equal((await getProject(project.id)).name, 'Customer Platform');
	assert.deepEqual(await resolveProjectContext(project.id), { projectId: project.id, projectName: 'Customer Platform', workspaceRoot: project.workspaceRoot });
	assert.ok((await listProjects()).some((candidate) => candidate.id === project.id));
});

test('rejects arbitrary and missing workspace roots', async () => {
	await assert.rejects(() => createProject({ name: 'Bad', workspaceRoot: 'relative/path' }), /absolute/);
	await assert.rejects(() => createProject({ name: 'Bad', workspaceRoot: join(workspace, 'missing') }), /does not exist/);
	await assert.rejects(() => resolveProjectContext('project-does-not-exist'), /does not exist/);
});
