<script>
	import AppShell from '$lib/components/AppShell.svelte';
	const { data } = $props();
	const modules = $derived(data.modules);
	const totalTools = $derived(modules.reduce((sum, module) => sum + module.toolCount, 0));
</script>

<svelte:head><title>Capabilities / KcevAgent</title><meta name="description" content="Inspect installed KcevAgent capabilities and tool authority." /></svelte:head>

<AppShell active="capabilities" context="Capabilities" identity={data.identity}>
	<main class="admin-page capability-page">
		<header class="page-heading"><div><p class="section-kicker">Runtime authority</p><h1>Capabilities</h1><p>Every tool available to the agent, its effect boundary, and the approval policy enforced before execution.</p></div><div class="header-metrics"><span><strong>{modules.length}</strong> modules</span><span><strong>{totalTools}</strong> tools</span></div></header>
		<section class="capability-summary" aria-label="Capability summary">
			<span><strong>{data.settings.domain}</strong><small>Default module</small></span>
			<span><strong>{modules.length}/{modules.length}</strong><small>Installed</small></span>
			<span><strong>{modules.reduce((sum, module) => sum + module.riskSummary.high, 0)}</strong><small>High-risk tools</small></span>
			<span><strong>{modules.reduce((sum, module) => sum + module.tools.filter((tool) => tool.approvalRequired).length, 0)}</strong><small>Approval gated</small></span>
		</section>
		{#each modules as module}
			<section class="capability-section" aria-labelledby={`module-${module.id}`}>
				<header class="section-heading"><div><h2 id={`module-${module.id}`}>{module.name}</h2><p>{module.capabilities.join(' · ')}</p></div><span class="run-status">{module.status}</span></header>
				<div class="capability-table" role="table" aria-label={`${module.name} tools`}>
					<div class="capability-row capability-row--header" role="row"><span>Tool</span><span>Access</span><span>Risk</span><span>Authority</span></div>
					{#each module.tools as tool}
						<div class="capability-row" role="row"><span><strong>{tool.name}</strong><small>{tool.description}</small></span><span><code>{tool.access}</code><small>{tool.permission}</small></span><span class="risk-label" data-risk={tool.risk}>{tool.risk}</span><span><strong>{tool.approvalRequired ? 'Approval required' : 'Policy allowed'}</strong><small>{tool.externalSideEffect ? 'External side effect' : 'Workspace scoped'}</small></span></div>
					{/each}
				</div>
			</section>
		{/each}
	</main>
</AppShell>
