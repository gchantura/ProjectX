import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeOrganizationStatusChange } from './organizationLifecycle.js';

const primary = '00000000-0000-4000-8000-000000000001';
const secondary = '00000000-0000-4000-8000-000000000002';
const platformAdmin = { authenticated: true, subject: 'platform@example.com', role: 'admin', platformAdmin: true, tenantId: primary };

test('allows a platform administrator to suspend another organization', () => {
	assert.deepEqual(authorizeOrganizationStatusChange(platformAdmin, secondary, 'suspended'), { allowed: true });
});

test('denies tenant administrators, invalid state, and current-organization lockout', () => {
	assert.equal(authorizeOrganizationStatusChange({ ...platformAdmin, platformAdmin: false }, secondary, 'suspended').status, 403);
	assert.equal(authorizeOrganizationStatusChange(platformAdmin, 'not-a-uuid', 'suspended').status, 400);
	assert.equal(authorizeOrganizationStatusChange(platformAdmin, secondary, 'deleted').status, 400);
	const self = authorizeOrganizationStatusChange(platformAdmin, primary, 'suspended');
	assert.equal(self.status, 409);
	assert.match(self.reason, /current session/i);
});
