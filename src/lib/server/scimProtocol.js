export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

export function normalizeScimUser(body, current = {}) {
	const userName = String(body?.userName ?? current.userName ?? '').trim().toLowerCase();
	const displayName = String(body?.displayName ?? body?.name?.formatted ?? current.displayName ?? userName).trim();
	const externalId = body?.externalId == null ? (current.externalId ?? null) : String(body.externalId).trim() || null;
	const role = normalizeRole(body?.roles?.[0]?.value ?? body?.role ?? current.role ?? 'operator');
	const active = body?.active == null ? (current.active ?? true) : body.active === true;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{1,127}$/.test(userName) || !displayName || displayName.length > 160 || (externalId && externalId.length > 255)) {
		throw Object.assign(new Error('A valid userName and displayName are required.'), { status: 400, scimType: 'invalidValue' });
	}
	return { userName, displayName, externalId, role, active };
}

export function applyScimPatch(current, body) {
	if (!Array.isArray(body?.schemas) || !body.schemas.includes(SCIM_PATCH_SCHEMA) || !Array.isArray(body?.Operations) || body.Operations.length === 0) {
		throw Object.assign(new Error('A SCIM PatchOp document with Operations is required.'), { status: 400, scimType: 'invalidSyntax' });
	}
	const next = { ...current };
	for (const operation of body.Operations) {
		if (String(operation?.op ?? '').toLowerCase() !== 'replace') throw Object.assign(new Error('Only replace patch operations are supported.'), { status: 400, scimType: 'invalidValue' });
		if (!operation.path && operation.value && typeof operation.value === 'object') Object.assign(next, operation.value);
		else if (['active', 'displayName', 'externalId'].includes(operation.path)) next[operation.path] = operation.value;
		else if (operation.path === 'roles') next.roles = operation.value;
		else throw Object.assign(new Error('The requested SCIM patch path is not supported.'), { status: 400, scimType: 'invalidPath' });
	}
	return normalizeScimUser(next, current);
}

export function parseScimFilter(filter) {
	if (!filter) return '';
	const match = String(filter).match(/^userName\s+eq\s+"([^"]{2,128})"$/i);
	if (!match) throw Object.assign(new Error('Only the userName eq filter is supported.'), { status: 400, scimType: 'invalidFilter' });
	return match[1].trim().toLowerCase();
}

export function publicScimUser(user, origin) {
	return {
		schemas: [SCIM_USER_SCHEMA],
		id: user.id,
		...(user.externalId ? { externalId: user.externalId } : {}),
		userName: user.userName,
		displayName: user.displayName,
		active: user.active,
		roles: [{ value: user.role, primary: true }],
		meta: { resourceType: 'User', created: user.createdAt, lastModified: user.updatedAt, location: `${origin}/api/scim/v2/Users/${user.id}` }
	};
}

export function scimError(error, fallbackStatus = 500) {
	const status = Number.isInteger(error?.status) ? error.status : fallbackStatus;
	return { status, body: { schemas: [SCIM_ERROR_SCHEMA], status: String(status), ...(error?.scimType ? { scimType: error.scimType } : {}), detail: status >= 500 ? 'SCIM provisioning is temporarily unavailable.' : String(error?.message || 'SCIM request failed.').slice(0, 240) } };
}

function normalizeRole(value) {
	const role = String(value ?? '').toLowerCase();
	if (!['viewer', 'operator', 'admin'].includes(role)) throw Object.assign(new Error('Role must be viewer, operator, or admin.'), { status: 400, scimType: 'invalidValue' });
	return role;
}
