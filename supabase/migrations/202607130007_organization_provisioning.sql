alter table public.agent_tenants add column if not exists slug text;
alter table public.agent_tenants add column if not exists status text not null default 'active';
alter table public.agent_tenants add column if not exists updated_at timestamptz not null default now();

update public.agent_tenants
set slug = 'tenant-' || replace(id::text, '-', '')
where slug is null;

alter table public.agent_tenants alter column slug set not null;
alter table public.agent_tenants drop constraint if exists agent_tenants_slug_check;
alter table public.agent_tenants add constraint agent_tenants_slug_check check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$');
alter table public.agent_tenants drop constraint if exists agent_tenants_status_check;
alter table public.agent_tenants add constraint agent_tenants_status_check check (status in ('active','suspended'));
create unique index if not exists agent_tenants_slug_uidx on public.agent_tenants (slug);

create table if not exists public.agent_tenant_events (
  tenant_id uuid not null references public.agent_tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  event_type text not null check (event_type in ('provisioned','suspended','reactivated')),
  actor_id text not null check (char_length(actor_id) between 2 and 128),
  event_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (tenant_id, id)
);

create index if not exists agent_tenant_events_tenant_idx on public.agent_tenant_events (tenant_id, event_at desc);
alter table public.agent_tenant_events enable row level security;
revoke all on public.agent_tenant_events from anon, authenticated;

create or replace function public.provision_agent_tenant(p_name text, p_slug text, p_admin jsonb, p_actor text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_tenant public.agent_tenants%rowtype;
  v_identity public.agent_identities%rowtype;
begin
  if char_length(coalesce(p_name,'')) not between 1 and 160
    or coalesce(p_slug,'') !~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'
    or coalesce(p_admin->>'id','') !~ '^[a-zA-Z0-9][a-zA-Z0-9._:@-]{1,127}$'
    or char_length(coalesce(p_admin->>'displayName','')) not between 1 and 160
    or coalesce(p_admin->>'tokenSha256','') !~ '^[a-f0-9]{64}$'
    or char_length(coalesce(p_actor,'')) not between 2 and 128 then
    raise exception 'invalid organization provisioning request';
  end if;

  insert into public.agent_tenants (name,slug,status,updated_at)
  values (p_name,p_slug,'active',now()) returning * into v_tenant;

  insert into public.agent_identities (tenant_id,id,display_name,role,token_sha256,status,created_by,updated_by)
  values (v_tenant.id,p_admin->>'id',p_admin->>'displayName','admin',p_admin->>'tokenSha256','active',p_actor,p_actor)
  returning * into v_identity;

  insert into public.agent_identity_events (tenant_id,identity_id,event_type,actor_id,metadata)
  values (v_tenant.id,v_identity.id,'created',p_actor,jsonb_build_object('role','admin','source','organization_provisioning'));

  insert into public.agent_tenant_events (tenant_id,event_type,actor_id,metadata)
  values (v_tenant.id,'provisioned',p_actor,jsonb_build_object('initialAdminId',v_identity.id));

  return jsonb_build_object(
    'organization',jsonb_build_object('id',v_tenant.id,'name',v_tenant.name,'slug',v_tenant.slug,'status',v_tenant.status,'createdAt',v_tenant.created_at,'updatedAt',v_tenant.updated_at),
    'identity',jsonb_build_object('id',v_identity.id,'displayName',v_identity.display_name,'role',v_identity.role,'status',v_identity.status,'tenantId',v_tenant.id,'tenantName',v_tenant.name,'createdAt',v_identity.created_at,'updatedAt',v_identity.updated_at)
  );
end;
$$;

revoke all on function public.provision_agent_tenant(text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.provision_agent_tenant(text,text,jsonb,text) to service_role;

comment on function public.provision_agent_tenant(text,text,jsonb,text) is
  'Atomically creates one organization and its first administrator. Accepts only a credential digest and is callable only by the server service role.';

create or replace function public.verify_agent_tenant_boundary(p_tenant_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_name text; v_slug text; v_status text; v_unique boolean;
begin
  select name,slug,status into v_name,v_slug,v_status from public.agent_tenants where id=p_tenant_id;
  if v_name is null then raise exception 'tenant not found'; end if;
  select exists (
    select 1 from pg_indexes
    where schemaname='public' and tablename='agent_identities'
      and indexname='agent_identities_token_sha256_global_uidx'
  ) into v_unique;
  return jsonb_build_object('tenantName',v_name,'tenantSlug',v_slug,'tenantStatus',v_status,'requestBound',true,'credentialGlobalUniqueness',v_unique,'organizationProvisioning',true);
end;
$$;

revoke all on function public.verify_agent_tenant_boundary(uuid) from public, anon, authenticated;
grant execute on function public.verify_agent_tenant_boundary(uuid) to service_role;
