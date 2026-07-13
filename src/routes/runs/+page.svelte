<script>
	import AppShell from '$lib/components/AppShell.svelte';
	const { data } = $props();
	let status = $state('all');
	let query = $state('');
	const runs = $derived(data.runs ?? []);
	const visibleRuns = $derived(runs.filter((run) => (status === 'all' || run.status === status) && (!query.trim() || `${run.task} ${run.id} ${run.config?.provider}`.toLowerCase().includes(query.trim().toLowerCase()))));
	const verified = $derived(runs.filter((run) => run.status === 'verified').length);
	const attention = $derived(runs.filter((run) => run.status === 'needs_attention').length);
	function dateLabel(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
	function duration(run) { const start = new Date(run.startedAt).getTime(); const end = new Date(run.endedAt ?? run.completedAt).getTime(); return Number.isFinite(start) && Number.isFinite(end) ? `${Math.max(0, Math.round((end - start) / 1000))}s` : '—'; }
</script>

<svelte:head><title>Runs / KcevAgent</title><meta name="description" content="Search and inspect the tenant run ledger." /></svelte:head>

<AppShell active="runs" context="Run ledger" identity={data.identity}>
	<main class="admin-page runs-page">
		<header class="page-heading"><div><p class="section-kicker">Tenant evidence</p><h1>Runs</h1><p>Search execution history, compare outcomes, and open the immutable evidence ledger for any run.</p></div><div class="header-metrics"><span><strong>{runs.length}</strong> recorded</span><span><strong>{verified}</strong> verified</span><span><strong>{attention}</strong> attention</span></div></header>
		<section class="run-filters" aria-label="Run filters"><label><span>Search</span><input type="search" bind:value={query} placeholder="Task, run ID, or provider" /></label><label><span>Status</span><select bind:value={status}><option value="all">All statuses</option><option value="verified">Verified</option><option value="needs_attention">Needs attention</option><option value="stopped">Stopped</option><option value="awaiting_approval">Awaiting approval</option></select></label></section>
		<section class="run-ledger" aria-label="Run ledger">
			<div class="run-ledger-row run-ledger-row--header"><span>Objective</span><span>Provider</span><span>Started</span><span>Duration</span><span>Status</span></div>
			{#each visibleRuns as run}
				<a class="run-ledger-row" href={`/runs/${run.id}`}><span><strong>{run.task}</strong><small>{run.id}</small></span><span><strong>{run.config?.provider}</strong><small>{run.config?.model}</small></span><span>{dateLabel(run.startedAt)}</span><span>{duration(run)}</span><span class="run-status" data-status={run.status}>{run.status.replaceAll('_', ' ')}</span></a>
			{:else}<div class="empty-execution"><strong>No matching runs</strong><span>Adjust the filters or start a run from Projects.</span></div>{/each}
		</section>
	</main>
</AppShell>
