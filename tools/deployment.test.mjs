import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseAllDocuments } from 'yaml';

const root = new URL('../', import.meta.url);

test('production image is multi-stage, non-root, health-checked, and uses the managed server', async () => {
	const dockerfile = await readFile(new URL('Dockerfile', root), 'utf8');
	assert.match(dockerfile, /^FROM node:\d+\.\d+\.\d+-bookworm-slim AS build/m);
	assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
	assert.match(dockerfile, /USER node/);
	assert.match(dockerfile, /HEALTHCHECK .*\/api\/health\/live/);
	assert.match(dockerfile, /CMD \["node", "tools\/server\.mjs"\]/);
	assert.doesNotMatch(dockerfile, /COPY .*\.env/i);
});

test('migration image applies checksum-tracked migrations under an advisory lock', async () => {
	const [dockerfile, script] = await Promise.all([readFile(new URL('Dockerfile.migrate', root), 'utf8'), readFile(new URL('tools/migrate.sh', root), 'utf8')]);
	assert.match(dockerfile, /^FROM postgres:\d+\.\d+-bookworm/m);
	assert.match(dockerfile, /USER postgres/);
	assert.match(script, /ON_ERROR_STOP/);
	assert.match(script, /pg_advisory_xact_lock/);
	assert.match(script, /checksum_sha256/);
	assert.match(script, /Checksum mismatch/);
	assert.match(script, /psql "\$DATABASE_URL" --no-psqlrc/);
});

test('Kubernetes baseline enforces safe rollout, probes, isolation, disruption, and scaling', async () => {
	const source = await readFile(new URL('deploy/kubernetes/base.yaml', root), 'utf8');
	const documents = parseAllDocuments(source);
	assert.ok(documents.every((document) => document.errors.length === 0));
	const resources = documents.map((document) => document.toJSON());
	const deployment = resources.find((item) => item.kind === 'Deployment');
	const config = resources.find((item) => item.kind === 'ConfigMap');
	const container = deployment.spec.template.spec.containers[0];
	assert.equal(config.data.KCEV_MAX_INFLIGHT_REQUESTS, '200');
	assert.equal(config.data.KCEV_TENANT_DISPLAY_NAME, 'Primary organization');
	assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0);
	assert.equal(deployment.spec.replicas, 2);
	assert.match(container.image, /@sha256:[a-f0-9]{64}$/);
	assert.equal(container.securityContext.readOnlyRootFilesystem, true);
	assert.equal(container.securityContext.allowPrivilegeEscalation, false);
	assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
	assert.equal(container.readinessProbe.httpGet.path, '/api/health/ready');
	assert.equal(container.livenessProbe.httpGet.path, '/api/health/live');
	assert.ok(resources.some((item) => item.kind === 'PodDisruptionBudget' && item.spec.minAvailable === 1));
	assert.ok(resources.some((item) => item.kind === 'HorizontalPodAutoscaler' && item.spec.maxReplicas === 10));
	assert.ok(resources.some((item) => item.kind === 'NetworkPolicy'));
});

test('Kubernetes monitoring defines authenticated scraping and actionable alerts', async () => {
	const source = await readFile(new URL('deploy/kubernetes/monitoring.yaml', root), 'utf8');
	const documents = parseAllDocuments(source);
	assert.ok(documents.every((document) => document.errors.length === 0));
	const resources = documents.map((document) => document.toJSON());
	const monitor = resources.find((item) => item.kind === 'ServiceMonitor');
	const rules = resources.find((item) => item.kind === 'PrometheusRule');
	assert.equal(monitor.spec.endpoints[0].path, '/api/metrics');
	assert.equal(monitor.spec.endpoints[0].authorization.credentials.name, 'kcevagent-monitoring');
	const alerts = rules.spec.groups.flatMap((group) => group.rules).map((rule) => rule.alert);
	for (const required of ['KcevAgentReplicaDown', 'KcevAgentHighServerErrorRate', 'KcevAgentAuditPersistenceFailure', 'KcevAgentAdmissionBackendFailure', 'KcevAgentReplicaSaturated']) assert.ok(alerts.includes(required));
	assert.ok(rules.spec.groups.flatMap((group) => group.rules).every((rule) => rule.annotations.runbook_url));
});

test('migration job is bounded, non-root, read-only, and digest pinned', async () => {
	const [document] = parseAllDocuments(await readFile(new URL('deploy/kubernetes/migration-job.yaml', root), 'utf8'));
	assert.equal(document.errors.length, 0);
	const job = document.toJSON();
	const container = job.spec.template.spec.containers[0];
	assert.equal(job.spec.backoffLimit, 2);
	assert.match(container.image, /@sha256:[a-f0-9]{64}$/);
	assert.equal(container.securityContext.readOnlyRootFilesystem, true);
	assert.equal(container.securityContext.allowPrivilegeEscalation, false);
	assert.equal(job.spec.template.spec.restartPolicy, 'Never');
});

test('CI builds both OCI artifacts with provenance, SBOMs, and production audit', async () => {
	const workflow = await readFile(new URL('.github/workflows/ai-system.yml', root), 'utf8');
	assert.match(workflow, /node-version: 24\.13\.0/);
	assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
	assert.match(workflow, /--provenance=mode=max --sbom=true/);
	assert.match(workflow, /Dockerfile\.migrate/);
	assert.match(workflow, /Dockerfile\.recovery/);
	assert.match(workflow, /tools\/capacity-test\.mjs/);
	assert.match(workflow, /KCEV_MAX_INFLIGHT_REQUESTS=100/);
	assert.match(workflow, /actions\/upload-artifact@v4/);
	const dockerignore = await readFile(new URL('.dockerignore', root), 'utf8');
	assert.match(dockerignore, /^\.env$/m);
	assert.match(dockerignore, /^\.env\.\*$/m);
});

test('recovery automation encrypts backups and restores only into an explicit isolated target', async () => {
	const [dockerfile, backup, restore, manifest] = await Promise.all([
		readFile(new URL('Dockerfile.recovery', root), 'utf8'), readFile(new URL('tools/backup.sh', root), 'utf8'),
		readFile(new URL('tools/restore-verify.sh', root), 'utf8'), readFile(new URL('deploy/kubernetes/recovery.yaml', root), 'utf8')
	]);
	assert.match(dockerfile, /^FROM postgres:\d+\.\d+-bookworm/m);
	assert.match(dockerfile, /USER postgres/);
	assert.match(backup, /pg_dump .*--format=custom/);
	assert.match(backup, /openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000/);
	assert.match(backup, /sha256sum database\.dump/);
	assert.match(backup, /BACKUP_RETENTION_DAYS/);
	assert.match(restore, /ALLOW_DESTRUCTIVE_RESTORE.*verify-isolated-database/);
	assert.match(restore, /sha256sum -c/);
	assert.match(restore, /pg_restore --dbname=.*--exit-on-error/);
	const documents = parseAllDocuments(manifest);
	assert.ok(documents.every((document) => document.errors.length === 0));
	const resources = documents.map((document) => document.toJSON());
	const jobs = resources.filter((item) => item.kind === 'CronJob');
	assert.equal(jobs.length, 2);
	assert.ok(jobs.every((job) => job.spec.concurrencyPolicy === 'Forbid' && job.spec.jobTemplate.spec.activeDeadlineSeconds > 0));
	assert.ok(jobs.every((job) => job.spec.jobTemplate.spec.template.spec.containers.every((container) => /@sha256:[a-f0-9]{64}$/.test(container.image) || container.name === 'isolated-postgres')));
});
