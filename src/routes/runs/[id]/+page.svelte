<script>
	import AppShell from '$lib/components/AppShell.svelte';
	const { data } = $props();
	const run = $derived(data.run);
	const ledger = $derived(data.ledger);
	const events = $derived(data.events ?? []);
	const graph = $derived(data.graph);

	const startedLabel = $derived.by(() => {
		const startedAt = new Date(run.startedAt);
		return Number.isNaN(startedAt.getTime())
		? run.startedAt
		: startedAt.toLocaleString();
	});
</script>

<svelte:head>
	<title>{run.id} / KcevAgent</title>
	<meta name="description" content="Inspect a persisted KcevAgent run ledger." />
</svelte:head>

<AppShell active="runs" context="Run evidence" identity={data.identity}>
<main class="admin-page run-detail-page">
	<header class="page-heading" aria-labelledby="run-title"><div><p class="section-kicker">Run evidence</p><h1 id="run-title">{run.task}</h1><p><code>{run.id}</code> · {startedLabel}</p></div><div class="header-actions"><span class="run-status" data-status={run.status}>{run.status.replace('_', ' ')}</span><a class="secondary-command" href={`/api/runs/${run.id}/export`}>Export audit bundle</a></div></header>

	<section class="panel detail-summary" aria-label="Run summary">
		<div>
			<span class="mini-badge">{run.config.provider}</span>
			<h2>{run.task}</h2>
		</div>
		<div class="ledger-strip" aria-label="Ledger record counts">
			<span>{ledger.steps.length} steps</span>
			<span>{ledger.toolCalls.length} tool calls</span>
			<span>{ledger.verifications.length} verifications</span>
			<span>{ledger.artifacts.length} artifacts</span>
			<span>{events.length} events</span>
		</div>
	</section>

	<section class="panel graph-panel" aria-label="Task graph">
		<div class="panel__header">
			<h2>Task graph</h2>
			<span class="mini-badge">{graph.summary.runnableNodes} runnable</span>
		</div>
		<div class="graph-metrics">
			<span>{graph.summary.totalNodes} nodes</span>
			<span>{graph.summary.verifiedNodes} satisfied</span>
			<span>{graph.summary.blockedNodes} blocked</span>
			<span>{graph.edges.length} edges</span>
		</div>
		<div class="task-graph" aria-label="Critical path">
			{#each graph.nodes as node, index}
				<article data-state={node.state}>
					<div>
						<span>{index + 1}</span>
						<strong>{node.label}</strong>
						<small>{node.role} / {node.tool}</small>
					</div>
					<em>{node.state}</em>
					<p>{node.verifierReason}</p>
				</article>
			{/each}
		</div>
	</section>

	<section class="detail-grid" aria-label="Run inspection">
		<div class="panel">
			<div class="panel__header">
				<h2>Step history</h2>
				<span class="mini-badge">{run.status}</span>
			</div>
			<div class="detail-step-list">
				{#each run.steps as step}
					<article>
						<div>
							<span class="status-dot" data-status={step.status}></span>
							<strong>{step.title}</strong>
						</div>
						<p>{step.description}</p>
						<dl>
							<div>
								<dt>Role</dt>
								<dd>{step.role}</dd>
							</div>
							<div>
								<dt>Tool</dt>
								<dd><code>{step.toolCall.name}</code></dd>
							</div>
							<div>
								<dt>Verifier</dt>
								<dd>{step.verification.reason}</dd>
							</div>
							<div>
								<dt>Raw output</dt>
								<dd><code>{step.rawOutput}</code></dd>
							</div>
						</dl>
					</article>
				{/each}
			</div>
		</div>

		<aside class="panel">
			<div class="panel__header">
				<h2>Ledger</h2>
				<span class="mini-badge">supabase</span>
			</div>
			<div class="ledger-table">
				<h3>Tool calls</h3>
				{#each ledger.toolCalls as call}
					<article>
						<strong>{call.step_id} / {call.name}</strong>
						<code>{JSON.stringify(call.args)}</code>
					</article>
				{/each}
			</div>
			<div class="ledger-table">
				<h3>Evidence</h3>
				{#each ledger.verifications as verification}
					<article data-status={verification.verified ? 'verified' : 'failed'}>
						<strong>{verification.step_id}</strong>
						<span>{verification.verified ? 'verified' : 'failed'}</span>
						<ul class="evidence-list">
							{#each verification.evidence as evidence}
								<li>{evidence}</li>
							{/each}
						</ul>
					</article>
				{/each}
			</div>
			<div class="ledger-table">
				<h3>Event timeline</h3>
				{#each events as event}
					<article>
						<strong>{event.position} / {event.type}</strong>
						<code>{event.createdAt}</code>
					</article>
				{/each}
			</div>
		</aside>
	</section>
</main>
</AppShell>
