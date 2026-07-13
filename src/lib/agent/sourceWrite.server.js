import { randomUUID } from 'node:crypto';
import { executeAgentTool } from './toolRegistry.server.js';
import { getAgentSettings, settingsToRunConfig } from './settingsStore.server.js';

const APPROVAL_PHRASE = 'APPROVE SOURCE WRITE';

export async function createApprovedSourceWrite(input = {}, options = {}) {
	const path = normalizePath(input.path);
	const content = normalizeContent(input.content);
	const reason = normalizeReason(input.reason);
	const approvalPhrase = String(input.approvalPhrase ?? '').trim();

	if (approvalPhrase !== APPROVAL_PHRASE) {
		throw Object.assign(new Error(`Approval phrase must be "${APPROVAL_PHRASE}".`), {
			status: 400
		});
	}

	const approval = {
		approved: true,
		id: `approval-${randomUUID()}`,
		path,
		reason,
		approvedAt: new Date().toISOString()
	};

	const config = options.config ?? settingsToRunConfig(await getAgentSettings());
	const result = await executeAgentTool({
		name: 'write_source',
		args: {
			path,
			content,
			approval
		}
	}, config);

	if (!result.ok) {
		throw Object.assign(new Error(result.output), { status: 400, evidence: result.evidence });
	}

	return {
		approval,
		output: result.output,
		evidence: result.evidence,
		durationMs: result.durationMs
	};
}

export function getSourceWriteApprovalPhrase() {
	return APPROVAL_PHRASE;
}

function normalizePath(path) {
	const value = String(path ?? '').trim().replaceAll('\\', '/');

	if (!value) {
		throw Object.assign(new Error('Source write path is required.'), { status: 400 });
	}

	if (value.startsWith('/') || /^[a-z]:\//i.test(value)) {
		throw Object.assign(new Error('Source write path must be workspace-relative.'), { status: 400 });
	}

	return value;
}

function normalizeContent(content) {
	const value = String(content ?? '');

	if (!value.trim()) {
		throw Object.assign(new Error('Source write content is required.'), { status: 400 });
	}

	return value;
}

function normalizeReason(reason) {
	const value = String(reason ?? '').trim();

	if (value.length < 12) {
		throw Object.assign(new Error('Approval reason must explain the intended change.'), {
			status: 400
		});
	}

	if (value.length > 500) {
		throw Object.assign(new Error('Approval reason must be 500 characters or fewer.'), {
			status: 400
		});
	}

	return value;
}
