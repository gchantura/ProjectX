<script>
	import AppShell from '$lib/components/AppShell.svelte';
	const { data } = $props();
	let query = $state('');
	let outcome = $state('all');
	const events = $derived(data.events.filter((event) => (outcome === 'all' || event.outcome === outcome) && `${event.actorId} ${event.action} ${event.resourceType ?? ''} ${event.requestId}`.toLowerCase().includes(query.toLowerCase())));
	function date(value) { return new Date(value).toLocaleString(); }
	function short(value) { return value ? `${value.slice(0, 8)}...${value.slice(-6)}` : 'none'; }
</script>

<svelte:head><title>Security audit / KcevAgent</title><meta name="description" content="Verified tenant security audit evidence." /></svelte:head>
<AppShell active="administration" context="Security audit" identity={data.identity}>
	<main class="admin-page audit-page">
		<header class="page-heading"><div><p class="section-kicker">Administration</p><h1>Security audit</h1><p>Append-only evidence for authenticated changes, correlated to application requests and distributed traces.</p></div><div class="header-actions"><span class="run-status" data-status={data.verification.valid ? 'verified' : 'needs_attention'}>{data.verification.valid ? 'chain verified' : 'verification failed'}</span><a class="secondary-command" href="/api/admin/audit">Export JSON</a></div></header>
		{#if data.auditError}<div class="inline-alert" role="alert">{data.auditError}</div>{/if}
		<section class="audit-summary" aria-label="Audit integrity"><span><strong>{data.verification.eventCount}</strong><small>Chained events</small></span><span><strong>{data.verification.valid ? 'Valid' : 'Invalid'}</strong><small>Integrity state</small></span><span><strong><code title={data.verification.headHash}>{short(data.verification.headHash)}</code></strong><small>Chain head</small></span></section>
		<section class="audit-section" aria-labelledby="audit-events-title"><header class="section-heading"><div><h2 id="audit-events-title">Change evidence</h2><p>Request payloads, access tokens, and credentials are excluded by design.</p></div></header><div class="audit-filters"><label>Search<input type="search" bind:value={query} placeholder="Actor, action, or request ID" /></label><label>Outcome<select bind:value={outcome}><option value="all">All outcomes</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option></select></label></div>
			<div class="audit-table" role="table" aria-label="Security audit events"><div class="audit-row audit-row--header" role="row"><span>Sequence / time</span><span>Actor</span><span>Action</span><span>Outcome</span><span>Correlation</span></div>{#each events as event}<div class="audit-row" role="row"><span><strong>#{event.sequence}</strong><small>{date(event.occurredAt)}</small></span><span><strong>{event.actorId}</strong><small>{event.actorRole}</small></span><span><strong>{event.action}</strong><small>{event.resourceType ?? 'application'}</small></span><span class="step-state" data-status={event.outcome === 'succeeded' ? 'verified' : 'failed'}>{event.outcome}</span><span><code title={event.requestId}>{short(event.requestId)}</code><small title={event.traceId}>trace {short(event.traceId)}</small></span></div>{:else}<div class="context-empty">No audit evidence matches these filters.</div>{/each}</div>
		</section>
	</main>
</AppShell>
