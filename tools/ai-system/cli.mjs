/** Command-line interface for synchronizing, validating, and assessing the canonical AI operating layer. */
import { assessComplexity, loadManifest, syncSystem, validateSystem } from './core.mjs';

const command = process.argv[2];
const value = (flag) => { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] ?? '' : ''; };

if (command === 'sync') {
	console.log(`Updated:\n${(await syncSystem()).map((item) => `- ${item}`).join('\n')}`);
} else if (command === 'check') {
	const issues = await validateSystem();
	if (issues.length) { console.error(`AI system validation failed:\n${issues.map((item) => `- ${item}`).join('\n')}`); process.exitCode = 1; }
	else console.log('AI system is synchronized and valid.');
} else if (command === 'assess') {
	const files = value('--files').split(',').map((item) => item.trim()).filter(Boolean);
	const manifest = await loadManifest();
	console.log(JSON.stringify(assessComplexity({ request: value('--request'), files, protectedPaths: manifest.complexity.protected_paths }), null, 2));
} else {
	console.error('Usage: node tools/ai-system/cli.mjs <sync|check|assess> [--request text] [--files a,b]');
	process.exitCode = 1;
}
