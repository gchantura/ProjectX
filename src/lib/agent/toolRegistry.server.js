import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateToolCall } from './runtime.js';
import { analyzeChangeImpact, formatImpactReport } from './impactAnalyzer.server.js';
import { validateExecutionContext } from './executionContext.server.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 6000;
const SOURCE_WRITE_ROOTS = ['src/', 'docs/', 'static/', 'tools/'];
const COMMAND_ALLOWLIST = new Map([
	['npm run ai:check', buildNpmCommand('ai:check')],
	['npm run ai:test', buildNpmCommand('ai:test')],
	['npm run build', buildNpmCommand('build')]
]);
const IGNORED_DIRECTORIES = new Set(['.git', '.svelte-kit', '.vercel', 'build', 'dist', 'node_modules', '.kcevagent']);

export async function executeAgentTool(call, config = {}) {
	if (config.executionContext) {
		try {
			const context = validateExecutionContext(config.executionContext, { config });
			if (!context.valid) return { ok: false, output: context.reason, evidence: ['execution-context:rejected'], durationMs: 0 };
		} catch (error) {
			return { ok: false, output: error?.message || 'Execution context validation failed.', evidence: ['execution-context:rejected'], durationMs: 0 };
		}
	}
	const sandbox = validateToolCall(call, config);

	if (!sandbox.allowed) {
		return {
			ok: false,
			output: sandbox.reason,
			evidence: ['sandbox:rejected'],
			durationMs: 0
		};
	}

	const started = Date.now();

	try {
		if (call.name === 'list_workspace') {
			const root = resolveWorkspacePath(call.args?.path ?? '.', config);
			const rootStats = await stat(root);
			if (!rootStats.isDirectory()) throw new Error('list_workspace path must be a directory.');
			const files = await listFiles(root, clamp(call.args?.limit, 1, 1000, 300), config);
			return { ok: true, output: files.join('\n'), evidence: [`directory:${relativeWorkspacePath(root, config) || '.'}`, `files:${files.length}`], durationMs: Date.now() - started };
		}

		if (call.name === 'search_workspace') {
			const query = String(call.args?.query ?? '').trim();
			if (!query || query.length > 200 || /[\r\n\0]/.test(query)) throw new Error('Search query must be 1-200 characters on one line.');
			const searchRoot = resolveWorkspacePath(call.args?.path ?? '.', config);
			const result = await execFileAsync('rg', ['--line-number', '--no-heading', '--color', 'never', '--fixed-strings', '--glob', '!node_modules/**', '--glob', '!.git/**', '--glob', '!build/**', '--glob', '!.svelte-kit/**', query, searchRoot], { cwd: workspaceRoot(config), timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 }).catch((error) => error.code === 1 ? { stdout: '', stderr: '' } : Promise.reject(error));
			const output = truncate(result.stdout || 'No matches found.');
			return { ok: true, output, evidence: [`search:${query}`, `scope:${relativeWorkspacePath(searchRoot, config) || '.'}`], durationMs: Date.now() - started };
		}

		if (call.name === 'inspect_diff') {
			const args = ['diff', '--no-ext-diff', '--unified=3'];
			if (call.args?.staged === true) args.push('--cached');
			if (call.args?.path) args.push('--', relativeWorkspacePath(resolveWorkspacePath(call.args.path, config), config));
			const result = await execFileAsync('git', args, { cwd: workspaceRoot(config), timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 });
			return { ok: true, output: truncate(result.stdout || 'No diff.'), evidence: [`git-diff:${call.args?.staged === true ? 'staged' : 'working-tree'}`], durationMs: Date.now() - started };
		}

		if (call.name === 'analyze_impact') {
			const target = relativeWorkspacePath(resolveWorkspacePath(call.args?.path, config), config);
			const impact = await analyzeChangeImpact(target, { root: workspaceRoot(config) });
			return { ok: true, output: truncate(formatImpactReport(impact)), evidence: [`impact-target:${impact.target}`, `impact-risk:${impact.riskLevel}`, `dependents:${impact.dependents.length}`, ...impact.recommendedValidations.map((command) => `recommended:${command}`)], durationMs: Date.now() - started };
		}

		if (call.name === 'inspect_context') {
			const filePath = resolveWorkspacePath(call.args?.path, config);
			const raw = await readFile(filePath, 'utf8');

			return {
				ok: true,
				output: truncate(raw),
				evidence: [`file:${path.relative(workspaceRoot(config), filePath).replaceAll('\\', '/')}`],
				durationMs: Date.now() - started
			};
		}

		if (call.name === 'run_validation') {
			const result = await runAllowlistedCommand(call.args?.command, call.args?.timeoutMs, config);

			return {
				ok: true,
				output: truncate([result.stdout, result.stderr].filter(Boolean).join('\n')),
				evidence: [`command:${call.args?.command}`],
				durationMs: Date.now() - started
			};
		}

		if (call.name === 'write_artifact') {
			const filePath = resolveArtifactPath(call.args?.path, config);
			const content = normalizeArtifactContent(call.args?.content);
			await mkdir(path.dirname(filePath), { recursive: true });
			await writeFile(filePath, content, 'utf8');

			return {
				ok: true,
				output: `Artifact written: ${relativeWorkspacePath(filePath, config)} (${content.length} bytes)`,
				evidence: [`artifact:${relativeWorkspacePath(filePath, config)}`],
				durationMs: Date.now() - started
			};
		}

		if (call.name === 'write_source') {
			const filePath = resolveSourceWritePath(call.args?.path, config);
			const relative = relativeWorkspacePath(filePath, config);
			const approval = validateSourceApproval(call.args?.approval, relative);
			const content = normalizeSourceContent(call.args?.content);
			await mkdir(path.dirname(filePath), { recursive: true });
			await writeFile(filePath, content, 'utf8');

			return {
				ok: true,
				output: `Source file written with approval ${approval.id}: ${relative} (${content.length} bytes)`,
				evidence: [`source-write:${relative}`, `approval:${approval.id}`],
				durationMs: Date.now() - started
			};
		}

		if (call.name === 'edit_source') {
			const filePath = resolveSourceWritePath(call.args?.path, config);
			const relative = relativeWorkspacePath(filePath, config);
			const original = await readFile(filePath, 'utf8');
			const originalHash = sha256(original);
			const expectedHash = String(call.args?.expectedSha256 ?? '').toLowerCase();
			if (expectedHash && expectedHash !== originalHash) throw new Error(`Source changed since inspection: expected ${expectedHash}, found ${originalHash}.`);
			const edits = normalizeEdits(call.args?.edits);
			let updated = original;
			for (const [index, edit] of edits.entries()) {
				const occurrences = countOccurrences(updated, edit.oldText);
				if (occurrences === 0) throw new Error(`Edit ${index + 1} did not match the current file.`);
				if (!edit.replaceAll && occurrences !== 1) throw new Error(`Edit ${index + 1} matched ${occurrences} locations; an exact unique match is required.`);
				updated = edit.replaceAll ? updated.split(edit.oldText).join(edit.newText) : updated.replace(edit.oldText, edit.newText);
			}
			if (updated === original) throw new Error('Source edit produced no change.');
			const checkpointId = `checkpoint-${randomUUID()}`;
			const checkpointRoot = path.join(workspaceRoot(config), '.kcevagent', 'checkpoints');
			await mkdir(checkpointRoot, { recursive: true });
			await writeFile(path.join(checkpointRoot, `${checkpointId}.json`), JSON.stringify({ version: 1, id: checkpointId, path: relative, beforeSha256: originalHash, afterSha256: sha256(updated), original, createdAt: new Date().toISOString() }), 'utf8');
			await atomicReplace(filePath, updated);
			const updatedHash = sha256(updated);
			return { ok: true, output: `Atomically edited ${relative}: ${edits.length} edit(s), sha256 ${originalHash} -> ${updatedHash}`, evidence: [`source-write:${relative}`, `sha256-before:${originalHash}`, `sha256-after:${updatedHash}`, `checkpoint:${checkpointId}`, `edits:${edits.length}`], durationMs: Date.now() - started };
		}

		if (call.name === 'rollback_checkpoint') {
			const checkpointId = String(call.args?.checkpointId ?? '');
			if (!/^checkpoint-[a-f0-9-]{36}$/i.test(checkpointId)) throw new Error('A valid checkpoint id is required.');
			const checkpointPath = path.join(workspaceRoot(config), '.kcevagent', 'checkpoints', `${checkpointId}.json`);
			const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
			const filePath = resolveSourceWritePath(checkpoint.path, config);
			const current = await readFile(filePath, 'utf8');
			if (sha256(current) !== checkpoint.afterSha256) throw new Error('Automatic rollback refused because the source changed after the checkpoint.');
			await atomicReplace(filePath, checkpoint.original);
			await rm(checkpointPath, { force: true });
			return { ok: true, output: `Rolled back ${checkpoint.path} to sha256 ${checkpoint.beforeSha256}.`, evidence: [`rollback:${checkpointId}`, `source-restored:${checkpoint.path}`, `sha256-restored:${checkpoint.beforeSha256}`], durationMs: Date.now() - started };
		}

		return {
			ok: false,
			output: `Unknown tool: ${call.name}`,
			evidence: ['tool:unknown'],
			durationMs: Date.now() - started
		};
	} catch (error) {
		return {
			ok: false,
			output: truncate(error?.message || String(error)),
			evidence: ['tool:error'],
			durationMs: Date.now() - started
		};
	}
}

export async function materializeRunTools(run) {
	const steps = [];

	for (const step of run.steps) {
		steps.push(await materializeRunStep(step, run.config));
	}

	const failedSteps = steps.filter((step) => step.status === 'failed').length;
	const verifiedSteps = steps.filter((step) => step.status === 'verified').length;
	const status = failedSteps > 0 ? 'needs_attention' : run.status;

	return {
		...run,
		status,
		summary: {
			...run.summary,
			verifiedSteps,
			failedSteps
		},
		steps
	};
}

export async function materializeRunStep(step, config = {}) {
	const result = await executeAgentTool(step.toolCall, config);
	const verification = {
		...step.verification,
		verified: step.verification.verified && result.ok,
		reason: result.ok
			? `${step.verification.reason} Server tool evidence captured.`
			: `Tool call failed: ${result.output}`,
		evidence: [...step.verification.evidence, ...result.evidence]
	};

	return {
		...step,
		status: verification.verified ? 'verified' : 'failed',
		durationMs: result.durationMs || step.durationMs,
		rawOutput: result.output,
		verification
	};
}

export function resolveWorkspacePath(inputPath, config = {}) {
	const value = String(inputPath ?? '').trim();

	if (!value) {
		throw new Error('Tool path is required.');
	}

	const root = workspaceRoot(config);
	const resolved = path.resolve(root, value);
	const relative = path.relative(root, resolved);

	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('Tool path outside workspace scope.');
	}
	const normalizedRelative = relative.replaceAll('\\', '/');
	if (Array.isArray(config.allowedPaths) && config.allowedPaths.length > 0 && !isAllowedPath(normalizedRelative, config.allowedPaths)) {
		throw new Error(`Tool path is outside the configured allowlist: ${config.allowedPaths.join(', ')}.`);
	}

	return resolved;
}

export function resolveArtifactPath(inputPath, config = {}) {
	const resolved = resolveWorkspacePath(inputPath, { workspaceRoot: workspaceRoot(config) });
	const relative = relativeWorkspacePath(resolved, config);

	if (!relative.startsWith('.kcevagent/artifacts/')) {
		throw new Error('Writable artifacts must stay inside .kcevagent/artifacts/.');
	}

	return resolved;
}

export function resolveSourceWritePath(inputPath, config = {}) {
	const resolved = resolveWorkspacePath(inputPath, config);
	const relative = relativeWorkspacePath(resolved, config);

	if (!SOURCE_WRITE_ROOTS.some((root) => relative.startsWith(root))) {
		throw new Error(`Source writes must stay inside ${SOURCE_WRITE_ROOTS.join(', ')}.`);
	}

	return resolved;
}

function isAllowedPath(relative, allowedPaths) {
	return allowedPaths.some((entry) => {
		const allowed = String(entry ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
		if (allowed === '.' || allowed === '') return true;
		return relative === allowed || relative.startsWith(`${allowed}/`);
	});
}

async function runAllowlistedCommand(command, timeoutMs = 30000, config = {}) {
	const normalized = String(command ?? '').trim();
	const allowed = COMMAND_ALLOWLIST.get(normalized);

	if (!allowed) {
		throw new Error(`Command is not allowlisted: ${normalized}`);
	}

	return execFileAsync(allowed.file, allowed.args, {
		cwd: workspaceRoot(config),
		timeout: Math.min(Number(timeoutMs) || 30000, 30000),
		windowsHide: true,
		maxBuffer: 1024 * 1024
	});
}

function truncate(value) {
	const text = String(value ?? '');
	return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : text;
}

async function listFiles(root, limit, config = {}) {
	const result = [];
	async function visit(directory) {
		if (result.length >= limit) return;
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (result.length >= limit) break;
			if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
			const target = path.join(directory, entry.name);
			if (entry.isDirectory()) await visit(target);
			else if (entry.isFile()) result.push(relativeWorkspacePath(target, config));
		}
	}
	await visit(root);
	return result;
}

function clamp(value, min, max, fallback) { const number = Number(value); return Number.isInteger(number) ? Math.min(Math.max(number, min), max) : fallback; }

function normalizeArtifactContent(content) {
	const value = String(content ?? '');

	if (!value.trim()) {
		throw new Error('Artifact content is required.');
	}

	if (value.length > MAX_OUTPUT_CHARS) {
		throw new Error(`Artifact content must be ${MAX_OUTPUT_CHARS} characters or fewer.`);
	}

	return value;
}

function normalizeSourceContent(content) {
	const value = String(content ?? '');

	if (!value.trim()) {
		throw new Error('Source content is required.');
	}

	if (value.length > MAX_OUTPUT_CHARS) {
		throw new Error(`Source content must be ${MAX_OUTPUT_CHARS} characters or fewer.`);
	}

	return value;
}

function normalizeEdits(input) {
	if (!Array.isArray(input) || input.length === 0 || input.length > 20) throw new Error('Source edits must contain 1-20 replacements.');
	return input.map((edit) => {
		const oldText = String(edit?.oldText ?? '');
		const newText = String(edit?.newText ?? '');
		if (!oldText || oldText.length > 20_000 || newText.length > 20_000) throw new Error('Each source edit requires bounded oldText and newText.');
		return { oldText, newText, replaceAll: edit?.replaceAll === true };
	});
}

function countOccurrences(text, needle) { let count = 0; let position = 0; while ((position = text.indexOf(needle, position)) !== -1) { count += 1; position += needle.length; } return count; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

async function atomicReplace(filePath, content) {
	const transactionId = randomUUID();
	const tempPath = `${filePath}.kcev-${transactionId}.tmp`;
	const backupPath = `${filePath}.kcev-${transactionId}.bak`;
	let originalMoved = false;
	try {
		await writeFile(tempPath, content, 'utf8');
		await rename(filePath, backupPath);
		originalMoved = true;
		await rename(tempPath, filePath);
		originalMoved = false;
		await rm(backupPath, { force: true });
	} catch (error) {
		if (originalMoved) {
			await rm(filePath, { force: true });
			await rename(backupPath, filePath).catch(() => undefined);
		}
		throw error;
	} finally {
		await rm(tempPath, { force: true });
		if (!originalMoved) await rm(backupPath, { force: true });
	}
}

function validateSourceApproval(approval, relativePath) {
	if (approval?.approved !== true) {
		throw new Error('Source writes require approval.');
	}

	if (!/^approval-[a-z0-9-]+$/i.test(String(approval.id ?? ''))) {
		throw new Error('Source write approval id is invalid.');
	}

	if (approval.path !== relativePath) {
		throw new Error('Source write approval path does not match target path.');
	}

	return approval;
}

function relativeWorkspacePath(filePath, config = {}) {
	return path.relative(workspaceRoot(config), filePath).replaceAll('\\', '/');
}

function workspaceRoot(config = {}) {
	return path.resolve(String(config.workspaceRoot || process.cwd()));
}

function buildNpmCommand(script) {
	if (process.platform === 'win32') {
		return { file: 'cmd.exe', args: ['/d', '/s', '/c', `npm run ${script}`] };
	}

	return { file: 'npm', args: ['run', script] };
}
