import { json } from '@sveltejs/kit';
export function GET() { return json({ status: 'ok', service: 'kcevagent', timestamp: new Date().toISOString() }); }
