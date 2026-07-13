<script>
	import AppShell from '$lib/components/AppShell.svelte';
	const { data } = $props();
	const report = $derived(data.report);
	let isRefreshing = $state(false);
	let refreshError = $state('');
	function percent(value) { return value == null ? 'No sample' : `${(value * 100).toFixed(1)}%`; }
	function duration(value) { return value == null ? 'No sample' : value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`; }
	function checkedAt(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
	async function runMaintenance() {
		isRefreshing = true; refreshError = '';
		try { const response = await fetch('/api/automation/maintenance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); if (!response.ok) throw new Error('Maintenance completed with failures.'); location.reload(); }
		catch (error) { refreshError = error.message; isRefreshing = false; }
	}
</script>

<svelte:head><title>Operations / KcevAgent</title><meta name="description" content="Production health, SLOs, incidents, dependencies, and workload ownership." /></svelte:head>

<AppShell active="operations" context="Operations" identity={data.identity}>
	<main class="admin-page operations-page">
		<header class="page-heading"><div><p class="section-kicker">Production control plane</p><h1>Operations</h1><p>Readiness, reliability objectives, dependency health, queue ownership, and remediation from persisted evidence.</p></div><div class="header-actions"><span class="run-status" data-status={report.status === 'healthy' ? 'verified' : report.status === 'critical' ? 'needs_attention' : 'running'}>{report.status}</span>{#if data.identity?.role !== 'viewer'}<button class="secondary-command" type="button" onclick={runMaintenance} disabled={isRefreshing}>{isRefreshing ? 'Refreshing...' : 'Run maintenance'}</button>{/if}</div></header>
		{#if refreshError}<div class="inline-alert" role="alert">{refreshError}</div>{/if}
		<section class="operations-summary" aria-label="Service level summary">
			<span><strong>{percent(report.metrics.successRate)}</strong><small>Verified run rate</small></span>
			<span><strong>{percent(report.metrics.needsAttentionRate)}</strong><small>Needs attention</small></span>
			<span><strong>{duration(report.metrics.p95DurationMs)}</strong><small>p95 run duration</small></span>
			<span><strong>{report.metrics.readyProviders}/{report.metrics.totalProviders}</strong><small>Providers ready</small></span>
			<span><strong>{report.workload.activeRunLeases}</strong><small>Active leases</small></span>
			<span><strong>{report.workload.pendingRunApprovals}</strong><small>Pending approvals</small></span>
		</section>
		<section class="operations-section" aria-labelledby="incident-title"><header class="section-heading"><div><h2 id="incident-title">Incidents and actions</h2><p>Evaluated at {checkedAt(report.checkedAt)} across {report.window.observedRuns} observed runs.</p></div><span class="environment-badge">{report.incidents.length} open</span></header><div class="incident-list">{#each report.incidents as incident}<article data-severity={incident.severity}><span>{incident.severity}</span><div><strong>{incident.title}</strong><p>{incident.detail}</p><small>{incident.action}</small></div></article>{:else}<div class="empty-execution"><strong>No open incidents</strong><span>Current evidence satisfies the configured service objectives.</span></div>{/each}</div></section>
		<section class="operations-grid">
			<div class="operations-section"><header class="section-heading"><div><h2>Dependencies</h2><p>Authoritative stores, security boundaries, providers, and replay evidence.</p></div></header><div class="dependency-list">{#each report.dependencies as dependency}<div><span class="readiness-dot" data-ready={dependency.status === 'passed'}></span><strong>{dependency.id.replace('provider:', '')}</strong><small>{dependency.message}</small><em>{dependency.status}</em></div>{/each}</div></div>
			<aside class="operations-section"><header class="section-heading"><div><h2>Process telemetry</h2><p>Current application instance.</p></div></header><dl class="process-stats"><div><dt>Uptime</dt><dd>{data.processTelemetry.uptimeSeconds}s</dd></div><div><dt>Counter series</dt><dd>{data.processTelemetry.counters.length}</dd></div><div><dt>Histogram series</dt><dd>{data.processTelemetry.histograms.length}</dd></div><div><dt>Token volume</dt><dd>{report.metrics.totalTokens}</dd></div><div><dt>Estimated spend</dt><dd>${report.metrics.totalEstimatedCostUsd.toFixed(4)}</dd></div></dl></aside>
		</section>
		<section class="operations-section" aria-labelledby="recent-runs-title"><header class="section-heading"><div><h2 id="recent-runs-title">Recent workload</h2><p>Latest persisted execution outcomes.</p></div><a href="/runs">Open run ledger</a></header><div class="recent-workload">{#each report.recentRuns as run}<a href={`/runs/${run.id}`}><span><strong>{run.task}</strong><small>{run.provider} · {run.verifiedSteps} verified · {duration(run.durationMs)}</small></span><span class="run-status" data-status={run.status}>{run.status.replaceAll('_', ' ')}</span></a>{:else}<div class="context-empty">No persisted workload is available.</div>{/each}</div></section>
	</main>
</AppShell>
