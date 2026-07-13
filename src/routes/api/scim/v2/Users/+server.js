import { SCIM_LIST_SCHEMA, normalizeScimUser, parseScimFilter, publicScimUser } from '$lib/server/scimProtocol.js';
import { scimFailure, scimJson, scimStore } from '$lib/server/scimRoutes.server.js';

export async function GET({ url, locals }) {
	try {
		const userName = parseScimFilter(url.searchParams.get('filter'));
		const startIndex = boundedInteger(url.searchParams.get('startIndex'), 1, 1, 1_000_000);
		const count = boundedInteger(url.searchParams.get('count'), 100, 1, 200);
		const store = scimStore(locals);
		const [users, totalResults] = await Promise.all([store.listScimUsers({ userName, offset: startIndex - 1, limit: count }), store.countScimUsers(userName)]);
		return scimJson({ schemas: [SCIM_LIST_SCHEMA], totalResults, startIndex, itemsPerPage: users.length, Resources: users.map((user) => publicScimUser(user, url.origin)) });
	} catch (error) { return scimFailure(error); }
}

export async function POST({ request, url, locals }) {
	try {
		const user = normalizeScimUser(await request.json());
		const stored = await scimStore(locals).upsertScimUser(null, user, locals.identity.subject);
		const resource = publicScimUser(stored, url.origin);
		return scimJson(resource, { status: 201, headers: { location: resource.meta.location } });
	} catch (error) { return scimFailure(error); }
}

function boundedInteger(value, fallback, minimum, maximum) {
	if (value == null || value === '') return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum) throw Object.assign(new Error('Pagination values must be positive integers.'), { status: 400, scimType: 'invalidValue' });
	return Math.min(parsed, maximum);
}
