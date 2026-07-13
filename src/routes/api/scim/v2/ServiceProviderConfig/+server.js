import { scimJson } from '$lib/server/scimRoutes.server.js';

export function GET() {
	return scimJson({
		schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
		documentationUri: 'https://docs.kcevagent.invalid/scim',
		patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
		filter: { supported: true, maxResults: 200 }, changePassword: { supported: false },
		sort: { supported: false }, etag: { supported: false },
		authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Tenant-bound bearer token issued in KcevAgent Administration', specUri: 'https://www.rfc-editor.org/rfc/rfc6750', primary: true }]
	});
}
