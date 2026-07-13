import { applyScimPatch, normalizeScimUser, publicScimUser } from '$lib/server/scimProtocol.js';
import { scimFailure, scimJson, scimStore } from '$lib/server/scimRoutes.server.js';

export async function GET({ params, url, locals }) {
	try {
		validateId(params.id);
		const user = await scimStore(locals).getScimUser(params.id);
		return user ? scimJson(publicScimUser(user, url.origin)) : notFound();
	} catch (error) { return scimFailure(error); }
}

export async function PUT({ params, request, url, locals }) {
	try {
		validateId(params.id);
		const store = scimStore(locals);
		const current = await store.getScimUser(params.id);
		if (!current) return notFound();
		const user = normalizeScimUser(await request.json(), current);
		if (user.userName !== current.userName) throw Object.assign(new Error('userName cannot be changed after provisioning.'), { status: 400, scimType: 'mutability' });
		return scimJson(publicScimUser(await store.upsertScimUser(params.id, user, locals.identity.subject), url.origin));
	} catch (error) { return scimFailure(error); }
}

export async function PATCH({ params, request, url, locals }) {
	try {
		validateId(params.id);
		const store = scimStore(locals);
		const current = await store.getScimUser(params.id);
		if (!current) return notFound();
		const user = applyScimPatch(current, await request.json());
		return scimJson(publicScimUser(await store.upsertScimUser(params.id, user, locals.identity.subject), url.origin));
	} catch (error) { return scimFailure(error); }
}

export async function DELETE({ params, locals }) {
	try {
		validateId(params.id);
		const result = await scimStore(locals).deprovisionScimUser(params.id, locals.identity.subject);
		return result?.found ? scimJson(null, { status: 204 }) : notFound();
	} catch (error) { return scimFailure(error); }
}

function validateId(id) { if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) throw Object.assign(new Error('Invalid SCIM resource identifier.'), { status: 400, scimType: 'invalidValue' }); }
function notFound() { return scimFailure(Object.assign(new Error('SCIM user not found.'), { status: 404 })); }
