#!/usr/bin/env node
import { rotateOidcConnectionSecrets } from '../src/lib/server/oidcSecretRotation.server.js';

const execute = process.argv.includes('--execute');
const invalid = process.argv.slice(2).filter((argument) => argument !== '--execute' && argument !== '--dry-run');
if (invalid.length > 0 || (process.argv.includes('--execute') && process.argv.includes('--dry-run'))) {
	console.error('Usage: npm run secrets:rotate -- [--dry-run | --execute]');
	process.exitCode = 2;
} else {
	try {
		const result = await rotateOidcConnectionSecrets({ execute });
		console.log(JSON.stringify(result, null, 2));
		if (!execute && result.pending > 0) console.log('Dry run only. Re-run with --execute after the keyring and backup are verified.');
		if (result.failed > 0) process.exitCode = 1;
	} catch (error) {
		console.error(String(error?.message ?? 'OIDC secret rotation failed.'));
		process.exitCode = 1;
	}
}
