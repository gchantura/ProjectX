import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeOidcMember, authorizeOidcOrganization } from './federatedAccess.js';

const tenantId = '00000000-0000-4000-8000-000000000002';
const transaction = { tenantId };

test('accepts only an active organization and member from the sealed tenant', () => {
	assert.deepEqual(authorizeOidcOrganization(transaction, { id: tenantId, status: 'active' }), { allowed: true });
	assert.deepEqual(authorizeOidcMember(transaction, { tenantId, tenantStatus: 'active', status: 'active' }), { allowed: true });
});

test('rejects suspended organizations and cross-tenant identity substitution', () => {
	assert.equal(authorizeOidcOrganization(transaction, { id: tenantId, status: 'suspended' }).code, 'suspended');
	assert.equal(authorizeOidcOrganization(transaction, { id: '00000000-0000-4000-8000-000000000003', status: 'active' }).code, 'organization-not-found');
	assert.equal(authorizeOidcMember(transaction, { tenantId: '00000000-0000-4000-8000-000000000003', tenantStatus: 'active', status: 'active' }).code, 'tenant-mismatch');
	assert.equal(authorizeOidcMember(transaction, { tenantId, tenantStatus: 'suspended', status: 'active' }).code, 'suspended');
});
