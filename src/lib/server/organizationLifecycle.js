const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function authorizeOrganizationStatusChange(identity, organizationId, status) {
	if (!identity?.authenticated || identity.platformAdmin !== true) return { allowed: false, status: 403, reason: 'Platform administrator authority required.' };
	if (!UUID.test(String(organizationId ?? '')) || !['active', 'suspended'].includes(status)) return { allowed: false, status: 400, reason: 'Provide a valid organization and lifecycle status.' };
	if (organizationId === identity.tenantId) return { allowed: false, status: 409, reason: 'You cannot change the status of the organization that owns your current session. Use a platform administrator from another active organization.' };
	return { allowed: true };
}
