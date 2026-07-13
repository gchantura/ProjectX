import { createHash, randomBytes } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).map((argument) => {
	const [key, ...value] = argument.replace(/^--/, '').split('=');
	return [key, value.join('=')];
}));
const id = String(args.id ?? '').trim();
const name = String(args.name ?? id).trim();
const role = String(args.role ?? 'operator').trim();
const tenantId = String(args['tenant-id'] ?? process.env.SUPABASE_TENANT_ID ?? '').trim();
const tenantName = String(args['tenant-name'] ?? process.env.KCEV_TENANT_DISPLAY_NAME ?? '').trim();

if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{1,127}$/.test(id) || !name || !['viewer', 'operator', 'admin'].includes(role) || (tenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId))) {
	console.error('Usage: npm run auth:operator -- --id=alice@example.com --name="Alice" --role=admin [--tenant-id=<uuid>] [--tenant-name="Organization"]');
	process.exit(1);
}

const token = `kcev_${randomBytes(32).toString('base64url')}`;
const operator = { id, name: name.slice(0, 160), role, tokenSha256: createHash('sha256').update(token).digest('hex'), ...(tenantId ? { tenantId, tenantName: (tenantName || `Organization ${tenantId.slice(0, 8)}`).slice(0, 160) } : {}) };

console.log('Personal access token (shown once):');
console.log(token);
console.log('\nAdd this object to KCEV_OPERATORS_JSON:');
console.log(JSON.stringify(operator));
