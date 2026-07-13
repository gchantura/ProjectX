import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentTenantContext, withTenantContext } from './tenantContext.js';

test('isolates tenant authority across concurrent asynchronous requests', async () => {
	const seen = await Promise.all([
		withTenantContext({ id: '00000000-0000-4000-8000-000000000001', name: 'Northwind' }, async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return currentTenantContext(); }),
		withTenantContext({ id: '00000000-0000-4000-8000-000000000002', name: 'Contoso' }, async () => { await Promise.resolve(); return currentTenantContext(); })
	]);
	assert.deepEqual(seen, [
		{ id: '00000000-0000-4000-8000-000000000001', name: 'Northwind' },
		{ id: '00000000-0000-4000-8000-000000000002', name: 'Contoso' }
	]);
	assert.equal(currentTenantContext(), null);
});
