import { createHash } from 'node:crypto';
import { createOidcConnectionStore } from './oidcConnectionStore.server.js';

export async function rotateOidcConnectionSecrets({ store = createOidcConnectionStore(), execute = false, actor = 'platform:key-rotation', signal, onProgress } = {}) {
	if (!store?.activeKeyId || typeof store.rotationInventory !== 'function' || typeof store.reencrypt !== 'function') throw Object.assign(new Error('The encrypted OIDC connection store is not configured.'), { code: 'SECRET_STORE_UNAVAILABLE' });
	if (typeof actor !== 'string' || actor.length < 2 || actor.length > 128) throw new Error('A valid rotation actor is required.');

	const byKey = {};
	const result = { mode: execute ? 'execute' : 'dry-run', activeKeyId: store.activeKeyId, total: 0, current: 0, pending: 0, rotated: 0, failed: 0, byKey, failures: [] };
	const pages = typeof store.rotationInventoryPages === 'function' ? store.rotationInventoryPages({ signal }) : singlePage(await store.rotationInventory({ signal }));
	for await (const page of pages) for (const record of page) {
		result.total += 1;
		byKey[record.encryptionKeyId] = (byKey[record.encryptionKeyId] ?? 0) + 1;
		if (record.encryptionKeyId === store.activeKeyId) { result.current += 1; continue; }
		result.pending += 1;
		if (!execute) continue;
		try {
			await store.reencrypt(record, actor, { signal });
			result.rotated += 1;
			onProgress?.({ status: 'rotated', completed: result.rotated + result.failed });
		} catch (error) {
			result.failed += 1;
			result.failures.push({ tenantRef: tenantReference(record.tenantId), code: String(error?.code ?? 'ROTATION_FAILED').slice(0, 80) });
			onProgress?.({ status: 'failed', completed: result.rotated + result.failed });
		}
	}
	return result;
}

async function* singlePage(records) { yield records; }

function tenantReference(tenantId) {
	return createHash('sha256').update(String(tenantId)).digest('hex').slice(0, 12);
}
