const RATE_PREFIX = {
	'cloud-openai': 'OPENAI',
	'cloud-anthropic': 'ANTHROPIC',
	'cloud-gemini': 'GEMINI',
	'cloud-xai': 'XAI'
};

export function calculateUsageCost(usage = {}, env = process.env, provider = 'cloud-openai') {
	const pricing = getProviderPricing(provider, env);
	if (!pricing.configured) return 0;
	return roundUsd(((Number(usage.inputTokens) || 0) * pricing.inputUsdPerMillion + (Number(usage.outputTokens) || 0) * pricing.outputUsdPerMillion) / 1_000_000);
}

export function getProviderPricing(provider, env = process.env) {
	if (provider === 'local-ollama' || provider === 'deterministic-local') return { configured: true, inputUsdPerMillion: 0, outputUsdPerMillion: 0, source: 'local' };
	const prefix = RATE_PREFIX[provider];
	if (!prefix) return { configured: false, inputUsdPerMillion: 0, outputUsdPerMillion: 0, source: 'unknown-provider' };
	const inputUsdPerMillion = rate(env[`KCEV_${prefix}_INPUT_USD_PER_MILLION`]);
	const outputUsdPerMillion = rate(env[`KCEV_${prefix}_OUTPUT_USD_PER_MILLION`]);
	return {
		configured: inputUsdPerMillion !== null && outputUsdPerMillion !== null,
		inputUsdPerMillion: inputUsdPerMillion ?? 0,
		outputUsdPerMillion: outputUsdPerMillion ?? 0,
		source: `KCEV_${prefix}_*_USD_PER_MILLION`
	};
}

export function collectRunUsage(run, completedSteps = []) {
	const planning = {
		inputTokens: Number(run.summary?.inputTokens) || 0,
		outputTokens: Number(run.summary?.outputTokens) || 0,
		totalTokens: Number(run.summary?.totalTokens) || 0
	};
	return completedSteps.reduce((usage, step) => {
		for (const role of ['executor', 'verifier']) addUsage(usage, step.providerTrace?.[role]?.usage);
		return usage;
	}, planning);
}

export function evaluateRunBudget(run, completedSteps = [], env = process.env) {
	const usage = collectRunUsage(run, completedSteps);
	const pricing = getProviderPricing(run.config?.provider, env);
	const costUsd = calculateUsageCost(usage, env, run.config?.provider);
	const tokenCeiling = Math.max(Number(run.config?.maxTokensPerRun) || 0, 0);
	const costCeiling = Math.max(Number(run.config?.costCeilingUsd) || 0, 0);
	const tokenExceeded = tokenCeiling > 0 && usage.totalTokens >= tokenCeiling;
	const pricingMissing = costCeiling > 0 && !pricing.configured;
	const costExceeded = costCeiling > 0 && costUsd >= costCeiling;
	return {
		allowed: !tokenExceeded && !costExceeded && !pricingMissing,
		usage, costUsd, tokenCeiling, costCeiling, pricing,
		reason: tokenExceeded ? `Token ceiling reached: ${usage.totalTokens}/${tokenCeiling}.` : pricingMissing ? `Cost ceiling cannot be enforced because pricing is not configured for ${run.config?.provider}.` : costExceeded ? `Cost ceiling reached: $${costUsd}/$${costCeiling}.` : 'Run remains inside configured budgets.'
	};
}

function addUsage(target, usage = {}) { target.inputTokens += Number(usage.inputTokens) || 0; target.outputTokens += Number(usage.outputTokens) || 0; target.totalTokens += Number(usage.totalTokens) || 0; }
function rate(value) { if (value === undefined || value === null || String(value).trim() === '') return null; const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function roundUsd(value) { return Math.round(value * 1_000_000) / 1_000_000; }
