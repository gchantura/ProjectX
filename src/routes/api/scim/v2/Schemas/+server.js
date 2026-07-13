import { SCIM_LIST_SCHEMA, SCIM_USER_SCHEMA } from '$lib/server/scimProtocol.js';
import { scimJson } from '$lib/server/scimRoutes.server.js';

export function GET({ url }) {
	const schema = { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'], id: SCIM_USER_SCHEMA, name: 'User', description: 'KcevAgent provisioned user', attributes: [
		{ name: 'userName', type: 'string', multiValued: false, required: true, caseExact: false, mutability: 'immutable', returned: 'default', uniqueness: 'server' },
		{ name: 'displayName', type: 'string', multiValued: false, required: true, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none' },
		{ name: 'active', type: 'boolean', multiValued: false, required: false, mutability: 'readWrite', returned: 'default' },
		{ name: 'roles', type: 'complex', multiValued: true, required: false, mutability: 'readWrite', returned: 'default', subAttributes: [{ name: 'value', type: 'string', multiValued: false, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none' }] }
	], meta: { resourceType: 'Schema', location: `${url.origin}/api/scim/v2/Schemas/${encodeURIComponent(SCIM_USER_SCHEMA)}` } };
	return scimJson({ schemas: [SCIM_LIST_SCHEMA], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [schema] });
}
