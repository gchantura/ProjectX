import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createSupabaseProjectStore, isSupabaseTestMode } from './supabaseStore.server.js';

const PROJECT_ID = /^project-[a-z0-9-]+$/i;

export async function ensureDefaultProject() {
	const projects = await listProjects();
	if (projects[0]) return projects[0];
	if (isSupabaseTestMode()) return createProject({ name: path.basename(process.cwd()), workspaceRoot: process.cwd() });
	throw Object.assign(new Error('No projects exist in Supabase. Create a project to continue.'), { status: 404, code: 'PROJECT_REQUIRED' });
}

export async function createProject(input = {}) {
	const workspaceRoot = await canonicalDirectory(input.workspaceRoot);
	const project = {
		id: `project-${randomUUID()}`,
		name: normalizeName(input.name || path.basename(workspaceRoot)),
		workspaceRoot,
		kind: 'local',
		status: 'ready'
	};
	return createSupabaseProjectStore().create(project);
}

export async function listProjects() {
	return createSupabaseProjectStore().list();
}

export async function getProject(id) {
	if (!PROJECT_ID.test(String(id ?? ''))) return undefined;
	return createSupabaseProjectStore().get(id);
}

export async function resolveProjectContext(projectId) {
	const project = projectId ? await getProject(projectId) : await ensureDefaultProject();
	if (!project) throw Object.assign(new Error('The selected project does not exist in Supabase.'), { status: 404, code: 'PROJECT_NOT_FOUND' });
	if (!project.workspaceRoot) throw Object.assign(new Error('The selected project has no server workspace path.'), { status: 409, code: 'PROJECT_PATH_MISSING' });
	const workspaceRoot = await canonicalDirectory(project.workspaceRoot);
	return { projectId: project.id, projectName: project.name, workspaceRoot };
}

async function canonicalDirectory(value) {
	const requested = String(value ?? '').trim();
	if (!requested || !path.isAbsolute(requested)) throw Object.assign(new Error('Project workspace must be an absolute server-local directory.'), { status: 400 });
	const resolved = await realpath(requested).catch(() => undefined);
	if (!resolved || !(await stat(resolved)).isDirectory()) throw Object.assign(new Error('Project workspace directory does not exist.'), { status: 400 });
	return path.resolve(resolved);
}

function normalizeName(value) {
	const name = String(value ?? '').trim().replace(/\s+/g, ' ');
	if (!name || name.length > 80) throw Object.assign(new Error('Project name must contain 1-80 characters.'), { status: 400 });
	return name;
}
