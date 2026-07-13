import { prometheusMetrics } from '$lib/server/telemetry.js';
export function GET() { return new Response(prometheusMetrics(), { headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' } }); }
