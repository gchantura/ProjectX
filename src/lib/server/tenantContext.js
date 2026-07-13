import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function withTenantContext(tenant, callback) {
	if (typeof callback !== 'function') throw new TypeError('Tenant context callback is required.');
	return storage.run(normalizeTenant(tenant), callback);
}

export function currentTenantContext() {
	const tenant = storage.getStore();
	return tenant ? { ...tenant } : null;
}

function normalizeTenant(tenant) {
	const id = String(typeof tenant === 'string' ? tenant : tenant?.id ?? '').trim();
	if (!id) return null;
	const name = String(typeof tenant === 'object' ? tenant?.name ?? '' : '').trim();
	return { id: id.slice(0, 128), name: (name || `Organization ${id.slice(0, 8)}`).slice(0, 160) };
}
