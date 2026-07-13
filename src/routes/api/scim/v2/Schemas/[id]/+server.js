import { SCIM_USER_SCHEMA } from '$lib/server/scimProtocol.js';
import { scimFailure, scimJson } from '$lib/server/scimRoutes.server.js';

export function GET({ params, url }) {
	if (params.id !== SCIM_USER_SCHEMA) return scimFailure(Object.assign(new Error('SCIM schema not found.'), { status: 404 }));
	return scimJson({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'], id: SCIM_USER_SCHEMA, name: 'User', description: 'KcevAgent provisioned user', attributes: [
		{ name: 'userName', type: 'string', multiValued: false, required: true, caseExact: false, mutability: 'immutable', returned: 'default', uniqueness: 'server' },
		{ name: 'displayName', type: 'string', multiValued: false, required: true, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none' },
		{ name: 'active', type: 'boolean', multiValued: false, required: false, mutability: 'readWrite', returned: 'default' },
		{ name: 'roles', type: 'complex', multiValued: true, required: false, mutability: 'readWrite', returned: 'default', subAttributes: [{ name: 'value', type: 'string', multiValued: false, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none' }] }
	], meta: { resourceType: 'Schema', location: `${url.origin}/api/scim/v2/Schemas/${encodeURIComponent(SCIM_USER_SCHEMA)}` } });
}
