import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCIM_PATCH_SCHEMA, applyScimPatch, normalizeScimUser, parseScimFilter, publicScimUser, scimError } from './scimProtocol.js';

test('normalizes a SCIM user into the supported authorization model', () => {
	assert.deepEqual(normalizeScimUser({ userName: 'Alice@Example.com', displayName: 'Alice', externalId: 'idp-1', active: true, roles: [{ value: 'viewer' }] }), { userName: 'alice@example.com', displayName: 'Alice', externalId: 'idp-1', active: true, role: 'viewer' });
});

test('applies bounded replace patches and rejects unsupported paths', () => {
	const current = { userName: 'alice@example.com', displayName: 'Alice', externalId: 'idp-1', active: true, role: 'operator' };
	assert.equal(applyScimPatch(current, { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'active', value: false }] }).active, false);
	assert.throws(() => applyScimPatch(current, { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'password', value: 'secret' }] }), (error) => error.scimType === 'invalidPath');
});

test('accepts only an exact userName equality filter', () => {
	assert.equal(parseScimFilter('userName eq "Alice@Example.com"'), 'alice@example.com');
	assert.throws(() => parseScimFilter('displayName co "Alice"'), (error) => error.scimType === 'invalidFilter');
});

test('renders SCIM resources without credential or tenant internals', () => {
	const resource = publicScimUser({ id: 'resource-id', externalId: 'idp-1', userName: 'alice@example.com', displayName: 'Alice', active: true, role: 'operator', createdAt: 'created', updatedAt: 'updated' }, 'https://agent.example.com');
	assert.equal(resource.meta.location, 'https://agent.example.com/api/scim/v2/Users/resource-id');
	assert.equal(resource.roles[0].value, 'operator');
	assert.doesNotMatch(JSON.stringify(resource), /tenant|token|credential/i);
});

test('redacts internal SCIM failures while preserving actionable client errors', () => {
	assert.equal(scimError(Object.assign(new Error('database exploded with secret'), { status: 503 })).body.detail, 'SCIM provisioning is temporarily unavailable.');
	assert.equal(scimError(Object.assign(new Error('Bad filter'), { status: 400, scimType: 'invalidFilter' })).body.detail, 'Bad filter');
});
