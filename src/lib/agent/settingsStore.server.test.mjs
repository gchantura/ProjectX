import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import {
	getAgentSettings,
	normalizeAgentSettings,
	saveAgentSettings,
	settingsToRunConfig
} from './settingsStore.server.js';
import { normalizeConfigInput } from './runStore.server.js';

let storeDir;

before(async () => {
	storeDir = await mkdtemp(join(tmpdir(), 'kcevagent-settings-'));
	process.env.KCEV_AGENT_DATA_DIR = storeDir;
});

after(async () => {
	delete process.env.KCEV_AGENT_DATA_DIR;
	await rm(storeDir, { force: true, recursive: true });
});

test('normalizes unsafe settings and never stores secret fields', () => {
	const settings = normalizeAgentSettings({
		provider: '../bad',
		model: 'kcev-sim-1',
		stepCeiling: 99,
		costCeilingUsd: -1,
		allowedPaths: ['src', '../escape', '/absolute'],
		networkAllowlist: ['https://api.example.com/path', 'bad host'],
		requireApprovalForSourceWrites: false,
		apiKey: 'secret'
	});

	assert.equal(settings.provider, 'deterministic-local');
	assert.equal(settings.stepCeiling, 12);
	assert.equal(settings.costCeilingUsd, 0);
	assert.equal(settings.planningMode, 'multi-hypothesis');
	assert.deepEqual(settings.allowedPaths, ['src/']);
	assert.deepEqual(settings.networkAllowlist, ['api.example.com']);
	assert.equal(settings.requireApprovalForSourceWrites, true);
	assert.equal('apiKey' in settings, false);
});

test('persists settings and maps them to run config defaults', async () => {
	const saved = await saveAgentSettings({
		provider: 'deterministic-local',
		model: 'kcev-sim-1',
		domain: 'coding',
		stepCeiling: 4,
		costCeilingUsd: 12.5,
		allowedPaths: 'src/\ndocs/',
		networkAllowlist: 'api.example.com'
	});
	const loaded = await getAgentSettings();
	const runConfig = settingsToRunConfig(loaded);
	const normalizedRunConfig = await normalizeConfigInput({});

	assert.deepEqual(loaded, saved);
	assert.equal(runConfig.stepCeiling, 4);
	assert.equal(runConfig.costCeilingUsd, 12.5);
	assert.equal(runConfig.workspaceScope, 'src/, docs/');
	assert.deepEqual(runConfig.allowedPaths, ['src/', 'docs/']);
	assert.deepEqual(runConfig.networkAllowlist, ['api.example.com']);
	assert.equal(runConfig.planningMode, 'multi-hypothesis');
	assert.equal(normalizedRunConfig.costCeilingUsd, 12.5);
});

test('isolates policy settings between registered project ids', async () => {
	await saveAgentSettings({ allowedPaths: ['src/'], stepCeiling: 2 }, { projectId: 'project-alpha' });
	await saveAgentSettings({ allowedPaths: ['docs/'], stepCeiling: 9 }, { projectId: 'project-beta' });
	assert.deepEqual((await getAgentSettings({ projectId: 'project-alpha' })).allowedPaths, ['src/']);
	assert.equal((await getAgentSettings({ projectId: 'project-alpha' })).stepCeiling, 2);
	assert.deepEqual((await getAgentSettings({ projectId: 'project-beta' })).allowedPaths, ['docs/']);
	assert.equal((await getAgentSettings({ projectId: 'project-beta' })).stepCeiling, 9);
});
