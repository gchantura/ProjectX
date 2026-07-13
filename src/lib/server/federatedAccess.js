export function authorizeOidcOrganization(transaction, organization) {
	if (!organization || organization.id !== transaction?.tenantId) return denied('organization-not-found', 'Organization is not available.');
	if (organization.status !== 'active') return denied('suspended', 'Organization access is suspended.');
	return { allowed: true };
}

export function authorizeOidcMember(transaction, member) {
	if (!member || member.status !== 'active') return denied('not-provisioned', 'Identity is not provisioned.');
	if (member.tenantId !== transaction?.tenantId) return denied('tenant-mismatch', 'Identity belongs to a different organization.');
	if (member.tenantStatus !== 'active') return denied('suspended', 'Organization access is suspended.');
	return { allowed: true };
}

function denied(code, reason) { return { allowed: false, status: 403, code, reason }; }
