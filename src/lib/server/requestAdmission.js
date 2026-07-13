const STATE_KEY = Symbol.for('kcev.request-admission.v1');
const DEFAULT_MAX_INFLIGHT_REQUESTS = 200;

export function requestAdmissionConfig(env = process.env) {
	return {
		maxInflightRequests: boundedInt(env.KCEV_MAX_INFLIGHT_REQUESTS, DEFAULT_MAX_INFLIGHT_REQUESTS, 1, 5_000)
	};
}

export function tryAcquireRequestSlot({ env = process.env, pathname = '/' } = {}) {
	const state = admissionState();
	const { maxInflightRequests: limit } = requestAdmissionConfig(env);
	state.limit = limit;

	if (pathname === '/api/health/live') {
		return { admitted: true, bypassed: true, active: state.active, limit, remaining: Math.max(0, limit - state.active), release: noop };
	}
	if (state.active >= limit) {
		state.rejected += 1;
		return { admitted: false, bypassed: false, active: state.active, limit, remaining: 0, rejectedTotal: state.rejected, release: noop };
	}

	state.active += 1;
	let released = false;
	return {
		admitted: true,
		bypassed: false,
		active: state.active,
		limit,
		remaining: Math.max(0, limit - state.active),
		release() {
			if (released) return;
			released = true;
			state.active = Math.max(0, state.active - 1);
		}
	};
}

export function requestAdmissionSnapshot() {
	const state = admissionState();
	return { active: state.active, limit: state.limit, rejected: state.rejected };
}

export function resetRequestAdmissionForTests() {
	if (process.env.NODE_ENV !== 'test') throw new Error('Request admission state can only be reset in tests.');
	globalThis[STATE_KEY] = { active: 0, limit: DEFAULT_MAX_INFLIGHT_REQUESTS, rejected: 0 };
}

function admissionState() {
	globalThis[STATE_KEY] ??= { active: 0, limit: requestAdmissionConfig().maxInflightRequests, rejected: 0 };
	return globalThis[STATE_KEY];
}

function boundedInt(value, fallback, min, max) {
	const parsed = Number(value);
	return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function noop() {}
