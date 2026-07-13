import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rotateOidcConnectionSecrets } from './oidcSecretRotation.server.js';

const records = [
	{ tenantId: '00000000-0000-4000-8000-000000000001', revision: 'r1', encryptionKeyId: 'old', ciphertext: 'opaque-1' },
	{ tenantId: '00000000-0000-4000-8000-000000000002', revision: 'r2', encryptionKeyId: 'current', ciphertext: 'opaque-2' }
];

test('reports retirement readiness without changing ciphertext during a dry run', async () => {
	let writes = 0;
	const result = await rotateOidcConnectionSecrets({ store: { activeKeyId: 'current', rotationInventory: async () => records, reencrypt: async () => { writes += 1; } } });
	assert.deepEqual({ mode: result.mode, total: result.total, current: result.current, pending: result.pending, rotated: result.rotated }, { mode: 'dry-run', total: 2, current: 1, pending: 1, rotated: 0 });
	assert.deepEqual(result.byKey, { old: 1, current: 1 });
	assert.equal(writes, 0);
	assert.doesNotMatch(JSON.stringify(result), /opaque|00000000/);
});

test('rotates stale records and returns redacted failures without stopping the batch', async () => {
	const attempted = [];
	const inventory = [...records, { tenantId: '00000000-0000-4000-8000-000000000003', revision: 'r3', encryptionKeyId: 'legacy', ciphertext: 'opaque-3' }];
	const result = await rotateOidcConnectionSecrets({ execute: true, store: { activeKeyId: 'current', rotationInventory: async () => inventory, reencrypt: async (record) => { attempted.push(record.tenantId); if (record.encryptionKeyId === 'legacy') throw Object.assign(new Error('failed'), { code: 'SECRET_INTEGRITY_FAILED' }); } } });
	assert.equal(result.rotated, 1);
	assert.equal(result.failed, 1);
	assert.equal(result.failures[0].code, 'SECRET_INTEGRITY_FAILED');
	assert.match(result.failures[0].tenantRef, /^[a-f0-9]{12}$/);
	assert.equal(attempted.length, 2);
	assert.doesNotMatch(JSON.stringify(result), /opaque|00000000/);
});
