import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessPresentation } from './loginPresentation.js';

test('login identifies the configured credential source', () => {
	const base = { operators: [], operatorToken: '', sessionSecret: 's'.repeat(32) };
	assert.equal(accessPresentation({ security: base, directoryConfigured: false, oidcEnabled: false, production: true }).setupRequired, true);
	assert.equal(accessPresentation({ security: { ...base, operatorToken: 'o'.repeat(32) }, directoryConfigured: false, oidcEnabled: false, production: true }).source, 'deployment');
	assert.equal(accessPresentation({ security: base, directoryConfigured: true, oidcEnabled: false, production: true }).source, 'administrator');
	assert.equal(accessPresentation({ security: { ...base, sessionSecret: '' }, directoryConfigured: false, oidcEnabled: true, production: true }).setupRequired, false);
});
