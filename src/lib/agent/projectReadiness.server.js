import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { resolveProjectContext } from './projectStore.server.js';

const execFileAsync = promisify(execFile);

export async function collectProjectReadiness(projectId, deps = {}) {
	const resolveContext = deps.resolveProjectContext ?? resolveProjectContext;
	const execGit = deps.execGit ?? git;
	const readPackage = deps.readPackage ?? readPackageManifest;
	const checkedAt = new Date().toISOString();
	const context = await resolveContext(projectId);
	const repository = await inspectRepository(context.workspaceRoot, execGit);
	const automation = await inspectAutomation(context.workspaceRoot, readPackage);
	const blockers = [
		...(repository.status === 'error' ? ['Repository state could not be inspected.'] : []),
		...(automation.hasPackageManifest && !automation.qualityGates.length ? ['No package quality gates were discovered.'] : [])
	];
	const warnings = [
		...(repository.status === 'not_indexed' ? ['Workspace is not inside a Git repository.'] : []),
		...(repository.dirty ? ['Repository has uncommitted changes.'] : []),
		...(!automation.hasPackageManifest ? ['No package.json was found in the project root.'] : [])
	];

	return {
		project: {
			id: context.projectId,
			name: context.projectName,
			workspaceRoot: context.workspaceRoot
		},
		checkedAt,
		status: blockers.length ? 'blocked' : warnings.length ? 'warning' : 'ready',
		blockers,
		warnings,
		repository,
		automation
	};
}

async function inspectRepository(workspaceRoot, execGit) {
	const root = await execGit(workspaceRoot, ['rev-parse', '--show-toplevel']);
	if (!root.ok) {
		return { status: 'not_indexed', dirty: false, root: null, branch: null, commit: null, changedFiles: 0 };
	}

	const [branch, commit, status] = await Promise.all([
		execGit(workspaceRoot, ['branch', '--show-current']),
		execGit(workspaceRoot, ['rev-parse', '--short=12', 'HEAD']),
		execGit(workspaceRoot, ['status', '--porcelain'])
	]);
	const changedFiles = status.ok ? status.stdout.split('\n').filter(Boolean).length : 0;

	return {
		status: branch.ok && commit.ok && status.ok ? 'indexed' : 'error',
		dirty: changedFiles > 0,
		root: root.stdout.trim(),
		branch: branch.stdout.trim() || 'detached',
		commit: commit.stdout.trim() || null,
		changedFiles
	};
}

async function inspectAutomation(workspaceRoot, readPackage) {
	const manifest = await readPackage(workspaceRoot);
	if (!manifest) return { hasPackageManifest: false, packageName: null, qualityGates: [], scripts: [] };
	const scripts = Object.keys(manifest.scripts ?? {}).sort();
	const qualityGateNames = ['test', 'ai:test', 'check', 'ai:check', 'lint', 'build', 'ai:validate'];
	return {
		hasPackageManifest: true,
		packageName: String(manifest.name ?? path.basename(workspaceRoot)),
		qualityGates: qualityGateNames.filter((name) => scripts.includes(name)),
		scripts
	};
}

async function readPackageManifest(workspaceRoot) {
	try {
		return JSON.parse(await readFile(path.join(workspaceRoot, 'package.json'), 'utf8'));
	} catch {
		return undefined;
	}
}

async function git(cwd, args) {
	try {
		const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 3000, windowsHide: true });
		return { ok: true, stdout };
	} catch (error) {
		return { ok: false, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? error?.message ?? '') };
	}
}
