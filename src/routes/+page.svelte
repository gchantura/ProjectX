<script>
	import { defaultAgentConfig } from '$lib';

	const { data } = $props();
	const emptyRun = { id: '', task: '', status: 'idle', config: defaultAgentConfig, summary: { totalSteps: 0, verifiedSteps: 0, failedSteps: 0, remainingSteps: 0, estimatedCostUsd: 0 }, steps: [] };

	let task = $state('');
	let projects = $state(readInitial(() => data.projects, []));
	let providers = $state(readInitial(() => data.providers, []));
	let projectName = $state('');
	let workspaceRoot = $state('');
	let isCreatingProject = $state(false);
	let projectError = $state(readInitial(() => data.storageError, ''));
	let probingProviderId = $state('');
	let run = $state(emptyRun);
	let runs = $state([]);
	let selectedStepId = $state('');
	let selectedProjectId = $state('');
	let selectedProviderId = $state('');
	let selectedModel = $state('');
	let stepCeiling = $state(defaultAgentConfig.stepCeiling);
	let autonomyMode = $state('execute');
	let isRunning = $state(false);
	let errorMessage = $state('');
	let streamStatus = $state('Ready');
	let controller = $state(null);
	let projectReadiness = $state(null);
	let preflightRun = $state(null);
	let approvalToken = $state('');
	let isPlanning = $state(false);

	let selectedProject = $derived(projects.find((project) => project.id === selectedProjectId));
	let selectedProvider = $derived(providers.find((provider) => provider.id === selectedProviderId) ?? providers[0]);
	let models = $derived(selectedProvider?.models ?? [selectedProvider?.defaultModel].filter(Boolean));
	let selectedStep = $derived(run.steps?.find((step) => step.id === selectedStepId) ?? run.steps?.[0]);
	let storage = $derived(data.diagnostics?.storage);
	let canReview = $derived(Boolean(data.identity?.role !== 'viewer' && task.trim() && selectedProjectId && selectedProvider?.ready && selectedModel && projectReadiness && projectReadiness.status !== 'blocked' && !isRunning && !isPlanning && !preflightRun));
	let canApprove = $derived(Boolean(data.identity?.role !== 'viewer' && preflightRun?.id && approvalToken && !isRunning && !isPlanning));

	$effect(() => {
		if (!selectedProviderId) selectedProviderId = providers.find((provider) => provider.ready)?.id ?? providers[0]?.id ?? defaultAgentConfig.provider;
		if (!selectedModel) selectedModel = providers.find((provider) => provider.id === selectedProviderId)?.defaultModel ?? defaultAgentConfig.model;
		if (selectedProvider && !models.includes(selectedModel)) selectedModel = selectedProvider.defaultModel ?? models[0] ?? '';
	});

	$effect(() => {
		if (selectedProjectId) {
			void loadRuns(selectedProjectId);
			void loadProjectReadiness(selectedProjectId);
		}
	});

	async function createProject(event) {
		event.preventDefault();
		isCreatingProject = true;
		projectError = '';
		try {
			const response = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: projectName, workspaceRoot }) });
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload.message ?? payload.error ?? `Project creation failed with status ${response.status}.`);
			projects = [payload.project, ...projects.filter((project) => project.id !== payload.project.id)];
			projectName = '';
			workspaceRoot = '';
			selectedProjectId = payload.project.id;
		} catch (error) { projectError = error.message; }
		finally { isCreatingProject = false; }
	}

	function openProject(project) {
		selectedProjectId = project.id;
		errorMessage = '';
	}

	function closeProject() {
		selectedProjectId = '';
		run = emptyRun;
		runs = [];
		projectReadiness = null;
		preflightRun = null;
		approvalToken = '';
	}

	function providerStatus(provider) {
		if (provider.ready) return 'connected';
		const credential = provider.probes?.find((probe) => probe.id === 'api-key');
		return credential && !credential.passed ? 'not configured' : 'error';
	}

	async function probeProvider(provider) {
		probingProviderId = provider.id;
		errorMessage = '';
		try {
			const response = await fetch('/api/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: provider.id, model: provider.selectedModel ?? provider.defaultModel }) });
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload.message ?? payload.error ?? `Provider test failed with status ${response.status}.`);
			providers = providers.map((item) => item.id === payload.provider.id ? payload.provider : item);
		} catch (error) { errorMessage = `${provider.name}: ${error.message}`; }
		finally { probingProviderId = ''; }
	}

	async function loadRuns(projectId) {
		try {
			const response = await fetch(`/api/runs?projectId=${encodeURIComponent(projectId)}`);
			if (!response.ok) throw new Error('Run history could not be loaded.');
			const payload = await response.json();
			runs = payload.runs.filter((candidate) => !projectId || candidate.config?.projectId === projectId);
			if (!run.id || run.config?.projectId !== projectId) selectRun(runs[0] ?? emptyRun);
		} catch (error) { errorMessage = error.message; }
	}

	async function loadProjectReadiness(projectId) {
		projectReadiness = null;
		try {
			const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/readiness`);
			if (!response.ok) throw new Error('Project readiness could not be inspected.');
			projectReadiness = (await response.json()).readiness;
		} catch (error) {
			projectReadiness = { status: 'blocked', blockers: [error.message], warnings: [], repository: {}, automation: {} };
		}
	}

	function selectProvider() {
		selectedModel = selectedProvider?.defaultModel ?? models[0] ?? '';
	}

	function selectRun(candidate) {
		run = candidate;
		selectedStepId = candidate.steps?.[0]?.id ?? '';
	}

	async function reviewPlan() {
		if (!canReview) return;
		controller?.abort();
		controller = new AbortController();
		isPlanning = true;
		errorMessage = '';
		streamStatus = 'Preparing preflight';
		try {
			const response = await fetch('/api/runs/preflight', {
				method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
				body: JSON.stringify({ task, mode: autonomyMode, config: { projectId: selectedProjectId, provider: selectedProviderId, model: selectedModel, domain: 'coding', stepCeiling } })
			});
			if (!response.ok) {
				const payload = await response.json().catch(() => ({}));
				throw new Error(payload.message ?? payload.error?.message ?? 'The preflight could not be created.');
			}
			const payload = await response.json();
			preflightRun = payload.run;
			approvalToken = payload.approvalToken;
			selectRun(payload.run);
			runs = [payload.run, ...runs.filter((item) => item.id !== payload.run.id)];
			streamStatus = 'Awaiting approval';
		} catch (error) {
			if (error.name !== 'AbortError') errorMessage = error.message;
			streamStatus = error.name === 'AbortError' ? 'Stopped' : 'Needs attention';
		} finally { isPlanning = false; controller = null; }
	}

	async function startApprovedRun() {
		if (!canApprove) return;
		controller?.abort();
		controller = new AbortController();
		isRunning = true;
		errorMessage = '';
		streamStatus = 'Claiming approved run';
		try {
			const response = await fetch('/api/runs/stream', {
				method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
				body: JSON.stringify({ preflightRunId: preflightRun.id, approvalToken })
			});
			if (!response.ok) {
				const payload = await response.json().catch(() => ({}));
				throw new Error(payload.message ?? payload.error?.message ?? 'The approved run could not be started.');
			}
			await readStream(response);
		} catch (error) {
			if (error.name !== 'AbortError') errorMessage = error.message;
			streamStatus = error.name === 'AbortError' ? 'Stopped' : 'Needs attention';
		} finally { isRunning = false; controller = null; }
	}

	async function discardPreflight() {
		if (!preflightRun?.id || isRunning || isPlanning) return;
		errorMessage = '';
		try {
			const response = await fetch(`/api/runs/${encodeURIComponent(preflightRun.id)}/approval`, { method: 'DELETE' });
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload.message ?? 'The plan could not be discarded.');
			selectRun(payload.run);
			runs = [payload.run, ...runs.filter((item) => item.id !== payload.run.id)];
			preflightRun = null;
			approvalToken = '';
			streamStatus = 'Ready';
		} catch (error) { errorMessage = error.message; }
	}

	function stopRun() { controller?.abort(); }

	async function readStream(response) {
		const reader = response.body?.getReader();
		if (!reader) throw new Error('Live run events are unavailable.');
		const decoder = new TextDecoder();
		let buffer = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) if (line.trim()) applyEvent(JSON.parse(line));
		}
		if (buffer.trim()) applyEvent(JSON.parse(buffer));
	}

	function applyEvent(event) {
		if (event.type === 'run_started' || event.type === 'run_resumed') {
			preflightRun = null; approvalToken = '';
			selectRun(event.run); runs = [event.run, ...runs.filter((item) => item.id !== event.run.id)]; streamStatus = 'Executing plan'; return;
		}
		if (event.step) {
			run = { ...run, steps: run.steps.map((step) => step.id === event.step.id ? { ...step, ...event.step } : step) };
			selectedStepId = event.step.id;
			streamStatus = event.type === 'step_started' ? `Running ${event.step.title}` : event.type === 'step_retrying' ? `Retrying ${event.step.title}` : `Reviewed ${event.step.title}`;
		}
		if (event.type === 'run_completed' || event.type === 'run_stopped') {
			selectRun(event.run); runs = [event.run, ...runs.filter((item) => item.id !== event.run.id)]; streamStatus = event.run.status === 'verified' ? 'Verified' : 'Needs attention';
		}
		if (event.type === 'error') { errorMessage = event.message; streamStatus = 'Needs attention'; }
	}

	function statusLabel(value) { return String(value || 'idle').replaceAll('_', ' '); }
	function compactTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
	async function signOut() { await fetch('/api/auth/session', { method: 'DELETE' }); location.assign('/login'); }
	function readInitial(read, fallback) { return read() ?? fallback; }
</script>

<svelte:head><title>KcevAgent | Project workspace</title><meta name="description" content="Governed autonomous engineering workspace." /></svelte:head>

<div class="workspace-shell">
	<aside class="workspace-nav">
		<a class="brand" href="/" aria-label="KcevAgent home"><span class="brand-mark">K</span><span>KcevAgent</span></a>
		<nav aria-label="Primary navigation">
			<a class="nav-item nav-item--active" href="/"><span class="nav-full">Projects</span><span class="nav-short">Projects</span></a>
			<a class="nav-item" href="/runs"><span class="nav-full">Runs</span><span class="nav-short">Runs</span></a>
			<a class="nav-item" href="/operations"><span class="nav-full">Operations</span><span class="nav-short">Ops</span></a>
			<a class="nav-item" href="/modules"><span class="nav-full">Capabilities</span><span class="nav-short">Tools</span></a>
			{#if data.identity?.role === 'admin'}<a class="nav-item" href="/settings"><span class="nav-full">Administration</span><span class="nav-short">Admin</span></a>{/if}
		</nav>
		<div class="nav-footer">
			<span class="storage-dot" data-ready={storage?.status === 'passed'}></span>
			<div><strong>{storage?.details?.authoritativeStore ?? 'storage unknown'}</strong><small>{storage?.details?.replicationMode === 'disabled' ? 'No remote replication' : storage?.details?.replicationMode}</small></div>
		</div>
	</aside>

	<div class="workspace-body">
		<header class="workspace-topbar">
			<div class="project-control">
				<span>Project</span>
				<strong>{selectedProject?.name ?? 'Select a project'}</strong>
				{#if selectedProject}<button class="quiet-button" type="button" onclick={closeProject}>Change project</button>{/if}
			</div>
			<div class="topbar-actions"><span class="identity-label"><strong>{data.identity?.name}</strong><small>{data.identity?.organization} / {data.identity?.role}</small></span>{#if data.identity?.role === 'admin'}<a href="/settings">Settings</a>{/if}<button class="quiet-button" type="button" onclick={signOut}>Sign out</button></div>
		</header>

		{#if !selectedProject}
		<main class="project-picker">
			<header class="page-heading"><div><p class="section-kicker">Supabase projects</p><h1>Select a project</h1><p>Every project shown here is queried live from the configured Supabase tenant.</p></div></header>
			{#if projectError}<div class="inline-alert" role="alert"><strong>Supabase project service unavailable</strong><span>{projectError}</span></div>{/if}
			<section class="project-list" aria-label="Available projects">
				{#each projects as project}
					<button class="project-row" type="button" onclick={() => openProject(project)}><span><strong>{project.name}</strong><small>{project.workspaceRoot}</small></span><span>{project.status}</span></button>
				{:else}<div class="empty-execution"><strong>No projects in Supabase</strong><span>Create the first project below. It will be written immediately.</span></div>{/each}
			</section>
			{#if data.identity?.role === 'admin'}<section class="project-create"><div><h2>Create project</h2><p>Register a server-local repository with this Supabase tenant.</p></div><form onsubmit={createProject}><label for="project-name">Project name</label><input id="project-name" bind:value={projectName} maxlength="80" required placeholder="Customer platform" /><label for="workspace-root">Absolute workspace path</label><input id="workspace-root" bind:value={workspaceRoot} required placeholder="C:\\path\\to\\repository" /><button class="primary-command" type="submit" disabled={isCreatingProject}>{isCreatingProject ? 'Creating project...' : 'Create and open project'}</button></form></section>{/if}
		</main>
		{:else}
		<main class="task-workspace">
			<section class="task-main">
				<header class="page-heading"><div><p class="section-kicker">{selectedProject?.name ?? 'Select a project'}</p><h1>What should the agent accomplish?</h1><p>Define the outcome. KcevAgent will plan, execute within project policy, and verify the result with evidence.</p></div><span class="run-status" data-status={run.status}>{statusLabel(isRunning ? 'running' : run.status)}</span></header>

				<section class="task-composer" aria-labelledby="objective-label">
					<label id="objective-label" for="objective">Objective</label>
			<textarea id="objective" bind:value={task} disabled={Boolean(preflightRun)} placeholder="Example: Find the cause of the latest failing build, implement the smallest safe fix, and verify it with the relevant tests."></textarea>
					<div class="composer-controls">
						<div class="control-group"><label for="autonomy">Autonomy</label><select id="autonomy" bind:value={autonomyMode} disabled={Boolean(preflightRun)}><option value="analyze">Analyze only</option><option value="propose">Propose changes</option><option value="execute">Execute within policy</option></select></div>
						<div class="control-group"><label for="provider">Provider</label><select id="provider" bind:value={selectedProviderId} onchange={selectProvider} disabled={Boolean(preflightRun)}>{#each providers as provider}<option value={provider.id}>{provider.name} · {providerStatus(provider)}</option>{/each}</select></div>
						<div class="control-group"><label for="model">Model</label><select id="model" bind:value={selectedModel} disabled={Boolean(preflightRun)}>{#each models as model}<option value={model}>{model}</option>{/each}</select></div>
						<div class="control-group control-group--small"><label for="steps">Max steps</label><input id="steps" type="number" min="1" max="12" bind:value={stepCeiling} disabled={Boolean(preflightRun)} /></div>
					</div>
					{#if errorMessage}<div class="inline-alert" role="alert"><strong>Run could not continue</strong><span>{errorMessage}</span></div>{/if}
					<div class="composer-footer"><div><span class="readiness-dot" data-ready={selectedProvider?.ready}></span>{selectedProvider?.ready ? `${selectedProvider.name} is ready` : 'Selected provider is unavailable'}<button class="quiet-button" type="button" onclick={() => probeProvider(selectedProvider)} disabled={!selectedProvider || Boolean(preflightRun) || probingProviderId === selectedProvider?.id}>{probingProviderId === selectedProvider?.id ? 'Testing...' : 'Test connection'}</button></div><div class="command-actions"><button class="secondary-command" type="button" onclick={stopRun} disabled={!isRunning && !isPlanning}>Stop</button><button class="primary-command" type="button" onclick={reviewPlan} disabled={!canReview}>{isPlanning ? streamStatus : preflightRun ? 'Plan ready' : 'Review plan'}</button></div></div>
				</section>

				{#if preflightRun}
				<section class="preflight-review" aria-labelledby="preflight-title">
					<div class="section-heading"><div><h2 id="preflight-title">Plan review</h2><p>{preflightRun.steps.length} steps · expires {compactTime(preflightRun.preflight?.expiresAt)}</p></div><span class="run-status" data-status="awaiting_approval">Approval required</span></div>
					<dl class="preflight-meta"><div><dt>Plan fingerprint</dt><dd>{preflightRun.preflight?.planSha256?.slice(0, 12)}</dd></div><div><dt>Autonomy</dt><dd>{statusLabel(preflightRun.config?.autonomyMode)}</dd></div><div><dt>Commit</dt><dd>{preflightRun.config?.executionContext?.commit ?? 'unknown'}</dd></div></dl>
					<div class="preflight-steps">{#each preflightRun.steps as step, index}<div><span class="step-index">{index + 1}</span><span><strong>{step.title}</strong><small>{step.evidenceRequired ?? step.description}</small></span><code>{step.tool}</code><em data-risk={step.risk}>{step.risk}</em></div>{/each}</div>
					<div class="preflight-actions"><button class="secondary-command" type="button" onclick={discardPreflight} disabled={isRunning}>Discard plan</button><button class="primary-command" type="button" onclick={startApprovedRun} disabled={!canApprove}>{isRunning ? streamStatus : 'Approve and execute'}</button></div>
				</section>
				{/if}

				<section class="execution-section">
					<div class="section-heading"><div><h2>Execution</h2><p>{run.id ? `${run.summary?.verifiedSteps ?? 0} verified of ${run.summary?.totalSteps ?? run.steps.length} steps` : 'The approved plan and live progress will appear here.'}</p></div>{#if run.id}<a href={`/runs/${run.id}`}>Open audit ledger</a>{/if}</div>
					{#if !run.id}<div class="empty-execution"><strong>No run selected</strong><span>Start a task or choose a previous run from the history.</span></div>{:else}<div class="step-list">{#each run.steps as step, index}<button class="step-row" class:step-row--selected={step.id === selectedStepId} type="button" onclick={() => selectedStepId = step.id}><span class="step-index">{index + 1}</span><span class="step-copy"><strong>{step.title}</strong><small>{step.description}</small></span><span class="step-tool">{step.tool}</span><span class="step-state" data-status={step.status}>{statusLabel(step.status)}</span></button>{/each}</div>{/if}
				</section>
				{#if run.id && ['verified', 'needs_attention', 'stopped'].includes(run.status)}
				<section class="completion-section" aria-labelledby="completion-title">
					<div class="section-heading"><div><h2 id="completion-title">Result</h2><p>{run.status === 'verified' ? 'Execution completed and every required verification passed.' : 'Execution stopped before all verification requirements passed.'}</p></div><span class="run-status" data-status={run.status}>{statusLabel(run.status)}</span></div>
					<div class="result-output"><h3>Actual output</h3><pre>{run.steps?.filter((step) => step.rawOutput).map((step) => step.rawOutput).join('\n\n') || 'No tool output was produced.'}</pre></div>
					{#if run.steps?.flatMap((step) => step.artifacts ?? []).length}<div class="result-artifacts"><h3>Artifacts</h3>{#each run.steps.flatMap((step) => step.artifacts ?? []) as artifact}<a href={artifact.path}>{artifact.path}</a>{/each}</div>{/if}
					<div class="verification-results"><h3>Verification steps</h3>{#each run.steps as step}<div data-passed={step.verification?.verified === true}><span>{step.verification?.verified ? 'Pass' : 'Fail'}</span><div><strong>{step.title}</strong><small>{step.verification?.reason ?? 'No verification result was recorded.'}</small></div></div>{/each}</div>
				</section>
				{/if}
			</section>

			<aside class="context-panel">
				<section><div class="context-heading"><h2>Evidence</h2><span>{selectedStep?.risk ?? 'low'} risk</span></div>{#if selectedStep}<p class="step-summary">{selectedStep.description}</p><dl class="evidence-meta"><div><dt>Agent role</dt><dd>{selectedStep.role}</dd></div><div><dt>Tool</dt><dd>{selectedStep.toolCall?.name ?? selectedStep.tool}</dd></div><div><dt>Verdict</dt><dd>{selectedStep.verification?.verified ? 'Verified' : statusLabel(selectedStep.status)}</dd></div></dl><div class="evidence-block"><h3>Verifier assessment</h3><p>{selectedStep.verification?.reason ?? 'Waiting for evidence.'}</p></div><div class="evidence-block"><h3>Evidence checked</h3>{#if selectedStep.verification?.evidence?.length}<ul>{#each selectedStep.verification.evidence as item}<li>{item}</li>{/each}</ul>{:else}<p>No evidence recorded yet.</p>{/if}</div><details><summary>Raw tool output</summary><pre>{selectedStep.rawOutput || 'No output recorded.'}</pre></details>{:else}<div class="context-empty">Select a run step to inspect its evidence and tool output.</div>{/if}</section>
				<section class="readiness-section">
					<div class="context-heading"><h2>Project readiness</h2><span data-status={projectReadiness?.status}>{projectReadiness?.status ?? 'checking'}</span></div>
					{#if projectReadiness}
						<dl class="evidence-meta">
							<div><dt>Git branch</dt><dd>{projectReadiness.repository?.branch ?? 'not indexed'}</dd></div>
							<div><dt>Commit</dt><dd>{projectReadiness.repository?.commit ?? 'unknown'}</dd></div>
							<div><dt>Changed files</dt><dd>{projectReadiness.repository?.changedFiles ?? 0}</dd></div>
							<div><dt>Quality gates</dt><dd>{projectReadiness.automation?.qualityGates?.join(', ') || 'none'}</dd></div>
						</dl>
						{#if projectReadiness.blockers?.length || projectReadiness.warnings?.length}
							<div class="readiness-notes">{#each [...(projectReadiness.blockers ?? []), ...(projectReadiness.warnings ?? [])] as note}<p>{note}</p>{/each}</div>
						{/if}
					{:else}
						<p class="context-empty">Inspecting repository, commit, and automation gates.</p>
					{/if}
				</section>
				<section class="history-section"><div class="context-heading"><h2>Recent runs</h2><span>{runs.length}</span></div>{#if runs.length}<div class="history-list">{#each runs.slice(0, 8) as item}<button type="button" class:history-item--active={item.id === run.id} onclick={() => selectRun(item)}><span><strong>{item.task}</strong><small>{compactTime(item.startedAt)}</small></span><em data-status={item.status}>{statusLabel(item.status)}</em></button>{/each}</div>{:else}<p class="context-empty">No runs have been recorded for this project.</p>{/if}</section>
			</aside>
		</main>
		{/if}
	</div>
</div>
