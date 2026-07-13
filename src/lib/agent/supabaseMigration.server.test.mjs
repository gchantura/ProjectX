import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const migrationPath = new URL('../../../supabase/migrations/202607120002_project_isolation.sql', import.meta.url);
const leaseMigrationPath = new URL('../../../supabase/migrations/202607130001_run_leases.sql', import.meta.url);
const preflightMigrationPath = new URL('../../../supabase/migrations/202607130002_run_preflight_approvals.sql', import.meta.url);
const identityMigrationPath = new URL('../../../supabase/migrations/202607130003_identity_directory.sql', import.meta.url);
const auditMigrationPath = new URL('../../../supabase/migrations/202607130004_security_audit_chain.sql', import.meta.url);
const rateLimitMigrationPath = new URL('../../../supabase/migrations/202607130005_distributed_rate_limits.sql', import.meta.url);
const requestBoundTenantMigrationPath = new URL('../../../supabase/migrations/202607130006_request_bound_tenants.sql', import.meta.url);
const organizationProvisioningMigrationPath = new URL('../../../supabase/migrations/202607130007_organization_provisioning.sql', import.meta.url);
const tenantLifecycleMigrationPath = new URL('../../../supabase/migrations/202607130008_tenant_lifecycle_enforcement.sql', import.meta.url);
const tenantOidcMigrationPath = new URL('../../../supabase/migrations/202607130009_tenant_oidc_connections.sql', import.meta.url);
const oidcSecretRotationMigrationPath = new URL('../../../supabase/migrations/202607130010_oidc_secret_key_rotation.sql', import.meta.url);
const organizationMembershipMigrationPath = new URL('../../../supabase/migrations/202607130011_organization_memberships.sql', import.meta.url);
const identityLifecycleMigrationPath = new URL('../../../supabase/migrations/202607130012_identity_lifecycle_automation.sql', import.meta.url);

test('project isolation migration keeps every durable record project-scoped', async () => {
	const sql = await readFile(migrationPath, 'utf8');
	assert.match(sql, /create table if not exists public\.agent_projects/i);
	for (const table of ['agent_runs', 'agent_run_events', 'agent_memories']) {
		assert.match(sql, new RegExp(`alter table public\\.${table} add column if not exists project_id text`, 'i'));
		assert.match(sql, new RegExp(`alter table public\\.${table} alter column project_id set not null`, 'i'));
	}
	assert.match(sql, /foreign key \(tenant_id,project_id\) references public\.agent_projects\(tenant_id,id\)/i);
	assert.match(sql, /where tenant_id=p_tenant_id and project_id=v_project_id and source_run_id=v_source_run_id/i);
	assert.match(sql, /grant execute on function public\.persist_agent_project\(uuid,jsonb\) to service_role/i);
});

test('preflight migration persists one-time approval decisions atomically', async () => {
	const sql = await readFile(preflightMigrationPath, 'utf8');
	assert.match(sql, /'awaiting_approval'/i);
	assert.match(sql, /create table if not exists public\.agent_run_approvals/i);
	assert.match(sql, /unique \(tenant_id, run_id\)/i);
	assert.match(sql, /decision='pending' and expires_at > now\(\)/i);
	assert.match(sql, /token_sha256=p_token_sha256/i);
	assert.match(sql, /grant execute on function public\.consume_agent_run_approval/i);
	assert.match(sql, /create or replace function public\.reject_agent_run_approval/i);
});

test('run lease migration provides atomic tenant-scoped worker ownership', async () => {
	const sql = await readFile(leaseMigrationPath, 'utf8');
	assert.match(sql, /create table if not exists public\.agent_run_leases/i);
	assert.match(sql, /primary key \(tenant_id, run_id\)/i);
	assert.match(sql, /on conflict \(tenant_id,run_id\) do update/i);
	assert.match(sql, /where public\.agent_run_leases\.expires_at <= now\(\)/i);
	assert.match(sql, /lease_token=p_lease_token and expires_at > now\(\)/i);
	assert.match(sql, /grant execute on function public\.claim_agent_run_lease/i);
});

test('identity migration provides tenant-scoped lifecycle audit and digest-only credentials', async () => {
	const sql = await readFile(identityMigrationPath, 'utf8');
	assert.match(sql, /create table if not exists public\.agent_identities/i);
	assert.match(sql, /token_sha256 text not null check/i);
	assert.match(sql, /unique \(tenant_id, token_sha256\)/i);
	assert.match(sql, /create table if not exists public\.agent_identity_events/i);
	assert.match(sql, /event_type in \('created','role_changed','token_rotated','revoked','federated_login'\)/i);
	assert.match(sql, /grant execute on function public\.upsert_agent_identity/i);
	assert.match(sql, /grant execute on function public\.revoke_agent_identity/i);
	assert.match(sql, /grant execute on function public\.record_agent_federated_login/i);
});

test('security audit migration serializes append-only tenant hash chains', async () => {
	const sql = await readFile(auditMigrationPath, 'utf8');
	assert.match(sql, /create table if not exists public\.agent_audit_events/i);
	assert.match(sql, /unique \(tenant_id, request_id, action\)/i);
	assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(p_tenant_id::text/i);
	assert.match(sql, /encode\(digest\(v_canonical,'sha256'\),'hex'\)/i);
	assert.match(sql, /previous_hash is distinct from expected_previous/i);
	assert.match(sql, /event_hash <> expected_hash/i);
	assert.match(sql, /grant execute on function public\.append_agent_audit_event\(uuid,jsonb\) to service_role/i);
	assert.match(sql, /revoke all on public\.agent_audit_events from anon, authenticated/i);
});

test('distributed rate-limit migration provides atomic tenant-scoped admission', async () => {
	const sql = await readFile(rateLimitMigrationPath, 'utf8');
	assert.match(sql, /primary key \(tenant_id, key_sha256, window_started_at\)/i);
	assert.match(sql, /on conflict \(tenant_id,key_sha256,window_started_at\) do update/i);
	assert.match(sql, /request_count=public\.agent_rate_limit_buckets\.request_count\+1/i);
	assert.match(sql, /v_count <= p_limit/i);
	assert.match(sql, /grant execute on function public\.consume_agent_rate_limit\(uuid,text,integer,integer\) to service_role/i);
});

test('request-bound tenant migration makes credential lookup globally unambiguous', async () => {
	const sql = await readFile(requestBoundTenantMigrationPath, 'utf8');
	assert.match(sql, /create unique index if not exists agent_identities_token_sha256_global_uidx/i);
	assert.match(sql, /on public\.agent_identities \(token_sha256\)/i);
	assert.match(sql, /create or replace function public\.verify_agent_tenant_boundary\(p_tenant_id uuid\)/i);
	assert.match(sql, /grant execute on function public\.verify_agent_tenant_boundary\(uuid\) to service_role/i);
});

test('organization provisioning is atomic, audited, digest-only, and service-role restricted', async () => {
	const sql = await readFile(organizationProvisioningMigrationPath, 'utf8');
	assert.match(sql, /create unique index if not exists agent_tenants_slug_uidx/i);
	assert.match(sql, /create table if not exists public\.agent_tenant_events/i);
	assert.match(sql, /create or replace function public\.provision_agent_tenant\(p_name text, p_slug text, p_admin jsonb, p_actor text\)/i);
	assert.match(sql, /insert into public\.agent_tenants[\s\S]+insert into public\.agent_identities[\s\S]+insert into public\.agent_tenant_events/i);
	assert.match(sql, /p_admin->>'tokenSha256'/i);
	assert.doesNotMatch(sql, /p_admin->>'token'/i);
	assert.match(sql, /revoke all on function public\.provision_agent_tenant\(text,text,jsonb,text\) from public, anon, authenticated/i);
	assert.match(sql, /grant execute on function public\.provision_agent_tenant\(text,text,jsonb,text\) to service_role/i);
	assert.match(sql, /'organizationProvisioning',true/i);
});

test('tenant lifecycle migration atomically enforces suspension and reactivation', async () => {
	const sql = await readFile(tenantLifecycleMigrationPath, 'utf8');
	assert.match(sql, /create or replace function public\.set_agent_tenant_status\(p_tenant_id uuid, p_status text, p_actor text\)/i);
	assert.match(sql, /select \* into v_tenant from public\.agent_tenants where id=p_tenant_id for update/i);
	assert.match(sql, /update public\.agent_tenants set status=p_status,updated_at=now\(\)/i);
	assert.match(sql, /insert into public\.agent_tenant_events/i);
	assert.match(sql, /revoke all on function public\.set_agent_tenant_status\(uuid,text,text\) from public, anon, authenticated/i);
	assert.match(sql, /grant execute on function public\.set_agent_tenant_status\(uuid,text,text\) to service_role/i);
	assert.match(sql, /'tenantLifecycleEnforcement',true/i);
});

test('tenant OIDC migration stores encrypted secrets behind audited service RPCs', async () => {
	const sql = await readFile(tenantOidcMigrationPath, 'utf8');
	assert.match(sql, /create table if not exists public\.agent_oidc_connections/i);
	assert.match(sql, /client_secret_ciphertext text not null check/i);
	assert.doesNotMatch(sql, /client_secret text/i);
	assert.match(sql, /create table if not exists public\.agent_oidc_connection_events/i);
	assert.match(sql, /event_type in \('configured','rotated','disabled','enabled'\)/i);
	assert.match(sql, /revision=excluded\.revision/i);
	assert.match(sql, /revoke all on public\.agent_oidc_connections, public\.agent_oidc_connection_events from anon, authenticated/i);
	assert.match(sql, /grant execute on function public\.upsert_agent_oidc_connection\(uuid,jsonb,text\) to service_role/i);
	assert.match(sql, /grant execute on function public\.set_agent_oidc_connection_status\(uuid,text,text\) to service_role/i);
	assert.match(sql, /'tenantOidcConnections',true/i);
});

test('OIDC secret rotation migration uses key versions and optimistic audited re-encryption', async () => {
	const sql = await readFile(oidcSecretRotationMigrationPath, 'utf8');
	assert.match(sql, /add column if not exists encryption_key_id text not null default 'legacy'/i);
	assert.match(sql, /create or replace function public\.get_agent_oidc_key_rotation_status\(p_active_key_id text\)/i);
	assert.match(sql, /jsonb_object_agg\(encryption_key_id,records\)/i);
	assert.match(sql, /grant execute on function public\.get_agent_oidc_key_rotation_status\(text\) to service_role/i);
	assert.match(sql, /event_type in \('configured','rotated','disabled','enabled','reencrypted'\)/i);
	assert.match(sql, /create or replace function public\.reencrypt_agent_oidc_connection\(p_tenant_id uuid, p_expected_revision uuid/i);
	assert.match(sql, /select \* into v_existing from public\.agent_oidc_connections where tenant_id=p_tenant_id for update/i);
	assert.match(sql, /v_existing\.revision <> p_expected_revision/i);
	assert.match(sql, /split_part\(p_ciphertext,'\.',2\) <> p_encryption_key_id/i);
	assert.match(sql, /client_secret_ciphertext like 'v1\.%' and encryption_key_id='legacy'/i);
	assert.match(sql, /'previousEncryptionKeyId',v_existing\.encryption_key_id/i);
	assert.match(sql, /grant execute on function public\.reencrypt_agent_oidc_connection\(uuid,uuid,text,text,text\) to service_role/i);
	assert.match(sql, /'managedSecretRotation',true/i);
});

test('organization membership migration backfills accounts and enforces service-only exact resolution', async () => {
	const sql = await readFile(organizationMembershipMigrationPath, 'utf8');
	assert.match(sql, /create table if not exists public\.agent_organization_memberships/i);
	assert.match(sql, /primary key \(account_tenant_id,identity_id,tenant_id\)/i);
	assert.match(sql, /foreign key \(account_tenant_id,identity_id\) references public\.agent_identities\(tenant_id,id\)/i);
	assert.match(sql, /select tenant_id,id,tenant_id,role,status,created_by,created_at,updated_at,revoked_by,revoked_at[\s\S]+from public\.agent_identities/i);
	assert.match(sql, /create trigger sync_agent_identity_home_membership/i);
	assert.match(sql, /update public\.agent_organization_memberships set status='revoked'[\s\S]+where account_tenant_id=new\.tenant_id and identity_id=new\.id and status='active'/i);
	assert.match(sql, /resolve_agent_organization_membership\(p_account_tenant_id uuid, p_identity_id text, p_tenant_id uuid\)/i);
	assert.match(sql, /m\.account_tenant_id=p_account_tenant_id and m\.identity_id=p_identity_id and m\.tenant_id=p_tenant_id/i);
	assert.match(sql, /home organization membership cannot be revoked independently/i);
	assert.match(sql, /home organization membership is managed by the identity directory/i);
	assert.match(sql, /revoke all on public\.agent_organization_memberships, public\.agent_organization_membership_events from anon, authenticated/i);
	assert.match(sql, /grant execute on function public\.upsert_agent_organization_membership\(uuid,uuid,text,text,text\) to service_role/i);
	assert.match(sql, /record_agent_federated_login\(p_tenant_id uuid, p_account_tenant_id uuid/i);
	assert.match(sql, /revoke all on function public\.record_agent_federated_login\(uuid,text,text,text,text\) from public, anon, authenticated, service_role/i);
	assert.match(sql, /'organizationMemberships',true/i);
});

test('identity lifecycle automation is single-use, digest-only, tenant-bound, and service restricted', async () => {
	const sql = await readFile(identityLifecycleMigrationPath, 'utf8');
	assert.match(sql, /create table if not exists public\.agent_identity_invitations/i);
	assert.match(sql, /unique index if not exists agent_identity_invitations_pending_uidx[\s\S]+where status='pending'/i);
	assert.match(sql, /status='pending' and expires_at>now\(\)[\s\S]+limit 1 for update/i);
	assert.match(sql, /update public\.agent_identity_invitations set status='accepted'/i);
	assert.match(sql, /p_subject_sha256 !~ '\^\[a-f0-9\]\{64\}\$'/i);
	assert.doesNotMatch(sql, /token text not null/i);
	assert.match(sql, /create unique index if not exists agent_scim_connections_token_uidx[\s\S]+token_sha256/i);
	assert.match(sql, /authenticate_agent_scim_token\(p_token_sha256 text\)/i);
	assert.match(sql, /c\.token_sha256=p_token_sha256 and c\.status='active'/i);
	assert.match(sql, /v_tenant\.id is null then return null/i);
	assert.match(sql, /update public\.agent_identities set status='revoked'[\s\S]+where tenant_id=p_tenant_id and id=v_resource\.identity_id and status='active'/i);
	assert.match(sql, /revoke all on public\.agent_identity_invitations[\s\S]+from anon, authenticated/i);
	assert.match(sql, /grant execute on function public\.authenticate_agent_scim_token\(text\) to service_role/i);
	assert.match(sql, /grant execute on function public\.redeem_agent_oidc_invitation\(uuid,text,text,text,text\) to service_role/i);
	assert.match(sql, /'identityLifecycleAutomation',true/i);
});
