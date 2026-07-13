import { SCIM_USER_SCHEMA } from '$lib/server/scimProtocol.js';
import { scimJson } from '$lib/server/scimRoutes.server.js';

export function GET({ url }) {
	return scimJson({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: SCIM_USER_SCHEMA, meta: { resourceType: 'ResourceType', location: `${url.origin}/api/scim/v2/ResourceTypes/User` } });
}
