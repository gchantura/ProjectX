import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { tryAcquireRequestSlot } from '../src/lib/server/requestAdmission.js';

export function createManagedServer({ handler, env = process.env, logger = defaultLogger } = {}) {
	if (typeof handler !== 'function') throw new TypeError('A Node request handler is required.');
	let draining = false;
	let shutdownPromise;
	const drainDelayMs = boundedInt(env.KCEV_DRAIN_DELAY_MS, 5_000, 0, 30_000);
	const graceMs = boundedInt(env.KCEV_SHUTDOWN_GRACE_MS, 30_000, 5_000, 120_000);
	const server = createServer((request, response) => {
		if (draining) {
			response.writeHead(503, { 'content-type': 'application/json', connection: 'close', 'retry-after': '5', 'cache-control': 'no-store' });
			response.end(JSON.stringify({ status: 'draining' }));
			return;
		}
		const admission = tryAcquireRequestSlot({ env, pathname: requestPathname(request.url) });
		response.setHeader('x-concurrency-limit', admission.limit);
		response.setHeader('x-concurrency-active', admission.active);
		response.setHeader('x-concurrency-remaining', admission.remaining);
		if (!admission.admitted) {
			if (shouldLogRejection(admission.rejectedTotal)) logger('warn', 'server.overloaded', { active: admission.active, limit: admission.limit, rejectedTotal: admission.rejectedTotal });
			response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '2', 'cache-control': 'no-store' });
			response.end(JSON.stringify({ status: 'overloaded' }));
			return;
		}
		response.once('finish', admission.release);
		response.once('close', admission.release);
		try { handler(request, response); }
		catch (error) { admission.release(); throw error; }
	});
	server.keepAliveTimeout = boundedInt(env.KCEV_KEEP_ALIVE_TIMEOUT_MS, 5_000, 1_000, 60_000);
	server.headersTimeout = Math.max(boundedInt(env.KCEV_HEADERS_TIMEOUT_MS, 10_000, 2_000, 120_000), server.keepAliveTimeout + 1_000);
	server.requestTimeout = boundedInt(env.KCEV_REQUEST_TIMEOUT_MS, 120_000, 10_000, 600_000);

	function start(port = boundedInt(env.PORT, 3000, 1, 65_535), host = env.HOST || '0.0.0.0') {
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, host, () => { server.off('error', reject); logger('info', 'server.started', { host, port: server.address()?.port }); resolve(server.address()); });
		});
	}

	function beginDrain(reason = 'shutdown') {
		if (shutdownPromise) return shutdownPromise;
		draining = true;
		logger('info', 'server.draining', { reason, drainDelayMs, graceMs });
		shutdownPromise = new Promise((resolve) => {
			const forceTimer = setTimeout(() => { logger('error', 'server.shutdown_forced', { reason }); server.closeAllConnections?.(); resolve({ forced: true }); }, graceMs);
			setTimeout(() => server.close(() => { clearTimeout(forceTimer); logger('info', 'server.stopped', { reason }); resolve({ forced: false }); }), drainDelayMs);
		});
		return shutdownPromise;
	}

	return { server, start, beginDrain, isDraining: () => draining };
}

async function main() {
	const { handler } = await import('../build/handler.js');
	const managed = createManagedServer({ handler });
	await managed.start();
	let exiting = false;
	const stop = async (reason, exitCode = 0) => {
		if (exiting) return;
		exiting = true;
		await managed.beginDrain(reason);
		process.exitCode = exitCode;
	};
	process.once('SIGTERM', () => void stop('SIGTERM'));
	process.once('SIGINT', () => void stop('SIGINT'));
	process.once('uncaughtException', (error) => { defaultLogger('error', 'server.uncaught_exception', { error: error?.message }); void stop('uncaughtException', 1); });
	process.once('unhandledRejection', (error) => { defaultLogger('error', 'server.unhandled_rejection', { error: error?.message ?? String(error) }); void stop('unhandledRejection', 1); });
}

function defaultLogger(level, event, fields = {}) { const output = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }); if (level === 'error') console.error(output); else console.info(output); }
function boundedInt(value, fallback, min, max) { const parsed = Number(value); return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback; }
function requestPathname(value) { try { return new URL(value ?? '/', 'http://localhost').pathname; } catch { return '/'; } }
function shouldLogRejection(total) { return total <= 10 || (total & (total - 1)) === 0; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
