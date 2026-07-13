create table if not exists public.agent_organization_memberships (
  account_tenant_id uuid not null,
  identity_id text not null,
  tenant_id uuid not null references public.agent_tenants(id) on delete cascade,
  role text not null check (role in ('viewer','operator','admin')),
  status text not null default 'active' check (status in ('active','revoked')),
  created_by text not null check (char_length(created_by) between 1 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_by text,
  revoked_at timestamptz,
  primary key (account_tenant_id,identity_id,tenant_id),
  foreign key (account_tenant_id,identity_id) references public.agent_identities(tenant_id,id) on delete cascade
);

create table if not exists public.agent_organization_membership_events (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  account_tenant_id uuid not null,
  identity_id text not null,
  event_type text not null check (event_type in ('granted','role_changed','reactivated','revoked')),
  actor_id text not null check (char_length(actor_id) between 1 and 160),
  event_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (tenant_id,id),
  foreign key (account_tenant_id,identity_id,tenant_id) references public.agent_organization_memberships(account_tenant_id,identity_id,tenant_id) on delete cascade
);

create index if not exists agent_organization_memberships_tenant_idx on public.agent_organization_memberships (tenant_id,status,updated_at desc);
create index if not exists agent_organization_memberships_account_idx on public.agent_organization_memberships (account_tenant_id,identity_id,status);
create index if not exists agent_organization_membership_events_idx on public.agent_organization_membership_events (tenant_id,event_at desc);
alter table public.agent_organization_memberships enable row level security;
alter table public.agent_organization_membership_events enable row level security;
revoke all on public.agent_organization_memberships, public.agent_organization_membership_events from anon, authenticated;

insert into public.agent_organization_memberships (account_tenant_id,identity_id,tenant_id,role,status,created_by,created_at,updated_at,revoked_by,revoked_at)
select tenant_id,id,tenant_id,role,status,created_by,created_at,updated_at,revoked_by,revoked_at
from public.agent_identities
on conflict (account_tenant_id,identity_id,tenant_id) do nothing;

create or replace function public.sync_agent_identity_home_membership()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if new.status='active' then
    insert into public.agent_organization_memberships (account_tenant_id,identity_id,tenant_id,role,status,created_by,created_at,updated_at,revoked_by,revoked_at)
    values (new.tenant_id,new.id,new.tenant_id,new.role,'active',new.created_by,new.created_at,now(),null,null)
    on conflict (account_tenant_id,identity_id,tenant_id) do update set role=excluded.role,status='active',updated_at=now(),revoked_by=null,revoked_at=null;
  elsif tg_op='UPDATE' then
    if old.status is distinct from new.status then
      update public.agent_organization_memberships set status='revoked',updated_at=now(),revoked_by=coalesce(new.revoked_by,'identity-directory'),revoked_at=coalesce(new.revoked_at,now())
      where account_tenant_id=new.tenant_id and identity_id=new.id and status='active';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_agent_identity_home_membership on public.agent_identities;
create trigger sync_agent_identity_home_membership after insert or update of role,status on public.agent_identities
for each row execute function public.sync_agent_identity_home_membership();

create or replace function public.list_agent_account_memberships(p_account_tenant_id uuid, p_identity_id text)
returns setof jsonb language sql security invoker set search_path=public as $$
  select jsonb_build_object(
    'accountTenantId',m.account_tenant_id,'identityId',m.identity_id,'tenantId',m.tenant_id,
    'tenantName',t.name,'tenantSlug',t.slug,'tenantStatus',t.status,'role',m.role,'status',m.status,
    'createdAt',m.created_at,'updatedAt',m.updated_at
  )
  from public.agent_organization_memberships m
  join public.agent_identities i on i.tenant_id=m.account_tenant_id and i.id=m.identity_id
  join public.agent_tenants t on t.id=m.tenant_id
  where m.account_tenant_id=p_account_tenant_id and m.identity_id=p_identity_id and i.status='active'
  order by t.name,m.tenant_id;
$$;

create or replace function public.resolve_agent_organization_membership(p_account_tenant_id uuid, p_identity_id text, p_tenant_id uuid)
returns jsonb language sql security invoker set search_path=public as $$
  select jsonb_build_object(
    'id',i.id,'displayName',i.display_name,'accountTenantId',i.tenant_id,
    'tenantId',m.tenant_id,'tenantName',t.name,'tenantSlug',t.slug,'tenantStatus',t.status,
    'role',m.role,'status',m.status
  )
  from public.agent_organization_memberships m
  join public.agent_identities i on i.tenant_id=m.account_tenant_id and i.id=m.identity_id
  join public.agent_tenants t on t.id=m.tenant_id
  where m.account_tenant_id=p_account_tenant_id and m.identity_id=p_identity_id and m.tenant_id=p_tenant_id
    and i.status='active' and m.status='active' and t.status='active';
$$;

create or replace function public.resolve_agent_federated_membership(p_tenant_id uuid, p_identity_id text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_matches jsonb[];
begin
  select array_agg(jsonb_build_object(
    'id',i.id,'displayName',i.display_name,'accountTenantId',i.tenant_id,
    'tenantId',m.tenant_id,'tenantName',t.name,'tenantSlug',t.slug,'tenantStatus',t.status,
    'role',m.role,'status',m.status
  )) into v_matches
  from public.agent_organization_memberships m
  join public.agent_identities i on i.tenant_id=m.account_tenant_id and i.id=m.identity_id
  join public.agent_tenants t on t.id=m.tenant_id
  where m.tenant_id=p_tenant_id and lower(i.id)=lower(p_identity_id)
    and i.status='active' and m.status='active' and t.status='active';
  return case when cardinality(v_matches)=1 then v_matches[1] else null end;
end;
$$;

create or replace function public.list_agent_organization_members(p_tenant_id uuid)
returns setof jsonb language sql security invoker set search_path=public as $$
  select jsonb_build_object(
    'accountTenantId',m.account_tenant_id,'identityId',m.identity_id,'displayName',i.display_name,
    'tenantId',m.tenant_id,'role',m.role,'status',m.status,'homeOrganization',m.account_tenant_id=m.tenant_id,
    'createdAt',m.created_at,'updatedAt',m.updated_at,'revokedAt',m.revoked_at
  )
  from public.agent_organization_memberships m
  join public.agent_identities i on i.tenant_id=m.account_tenant_id and i.id=m.identity_id
  where m.tenant_id=p_tenant_id
  order by m.updated_at desc,m.identity_id;
$$;

create or replace function public.upsert_agent_organization_membership(p_tenant_id uuid, p_account_tenant_id uuid, p_identity_id text, p_role text, p_actor text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_existing public.agent_organization_memberships%rowtype; v_stored public.agent_organization_memberships%rowtype; v_event text; v_display_name text;
begin
  if p_tenant_id is null or p_account_tenant_id is null or coalesce(p_identity_id,'') !~ '^[a-zA-Z0-9][a-zA-Z0-9._:@-]{1,127}$'
    or p_role not in ('viewer','operator','admin') or char_length(coalesce(p_actor,'')) not between 1 and 160 then raise exception 'invalid organization membership'; end if;
  if p_tenant_id=p_account_tenant_id then raise exception 'home organization membership is managed by the identity directory'; end if;
  select display_name into v_display_name from public.agent_identities where tenant_id=p_account_tenant_id and id=p_identity_id and status='active';
  if v_display_name is null or not exists (select 1 from public.agent_tenants where id=p_tenant_id and status='active') then raise exception 'active account or organization not found'; end if;
  select * into v_existing from public.agent_organization_memberships where account_tenant_id=p_account_tenant_id and identity_id=p_identity_id and tenant_id=p_tenant_id for update;
  v_event := case when v_existing.identity_id is null then 'granted' when v_existing.status='revoked' then 'reactivated' else 'role_changed' end;
  insert into public.agent_organization_memberships (account_tenant_id,identity_id,tenant_id,role,status,created_by,updated_at,revoked_by,revoked_at)
  values (p_account_tenant_id,p_identity_id,p_tenant_id,p_role,'active',p_actor,now(),null,null)
  on conflict (account_tenant_id,identity_id,tenant_id) do update set role=excluded.role,status='active',updated_at=now(),revoked_by=null,revoked_at=null
  returning * into v_stored;
  insert into public.agent_organization_membership_events (tenant_id,account_tenant_id,identity_id,event_type,actor_id,metadata)
  values (p_tenant_id,p_account_tenant_id,p_identity_id,v_event,p_actor,jsonb_build_object('role',p_role));
  return jsonb_build_object('accountTenantId',v_stored.account_tenant_id,'identityId',v_stored.identity_id,'displayName',v_display_name,'tenantId',v_stored.tenant_id,'role',v_stored.role,'status',v_stored.status,'homeOrganization',v_stored.account_tenant_id=v_stored.tenant_id,'createdAt',v_stored.created_at,'updatedAt',v_stored.updated_at);
end;
$$;

create or replace function public.revoke_agent_organization_membership(p_tenant_id uuid, p_account_tenant_id uuid, p_identity_id text, p_actor text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_stored public.agent_organization_memberships%rowtype;
begin
  if char_length(coalesce(p_actor,'')) not between 1 and 160 then raise exception 'invalid organization membership revocation'; end if;
  if p_tenant_id=p_account_tenant_id then raise exception 'home organization membership cannot be revoked independently'; end if;
  update public.agent_organization_memberships set status='revoked',updated_at=now(),revoked_by=p_actor,revoked_at=now()
  where tenant_id=p_tenant_id and account_tenant_id=p_account_tenant_id and identity_id=p_identity_id and status='active' returning * into v_stored;
  if v_stored.identity_id is null then return jsonb_build_object('revoked',false,'identityId',p_identity_id); end if;
  insert into public.agent_organization_membership_events (tenant_id,account_tenant_id,identity_id,event_type,actor_id)
  values (p_tenant_id,p_account_tenant_id,p_identity_id,'revoked',p_actor);
  return jsonb_build_object('revoked',true,'identityId',v_stored.identity_id,'accountTenantId',v_stored.account_tenant_id,'tenantId',v_stored.tenant_id,'status',v_stored.status,'revokedAt',v_stored.revoked_at);
end;
$$;

create or replace function public.record_agent_federated_login(p_tenant_id uuid, p_account_tenant_id uuid, p_identity_id text, p_actor text, p_issuer text, p_subject_sha256 text)
returns void language plpgsql security invoker set search_path=public as $$
begin
  if p_subject_sha256 !~ '^[a-f0-9]{64}$' or char_length(coalesce(p_issuer,'')) not between 1 and 500 then raise exception 'invalid federated login evidence'; end if;
  if not exists (
    select 1 from public.agent_organization_memberships m
    join public.agent_identities i on i.tenant_id=m.account_tenant_id and i.id=m.identity_id
    join public.agent_tenants t on t.id=m.tenant_id
    where m.tenant_id=p_tenant_id and m.account_tenant_id=p_account_tenant_id and i.id=p_identity_id
      and i.status='active' and m.status='active' and t.status='active'
  ) then raise exception 'active organization membership not found'; end if;
  insert into public.agent_identity_events (tenant_id,identity_id,event_type,actor_id,metadata)
  values (p_account_tenant_id,p_identity_id,'federated_login',p_actor,jsonb_build_object('issuer',p_issuer,'subjectSha256',p_subject_sha256,'organizationTenantId',p_tenant_id));
end;
$$;

revoke all on function public.list_agent_account_memberships(uuid,text) from public, anon, authenticated;
revoke all on function public.resolve_agent_organization_membership(uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.resolve_agent_federated_membership(uuid,text) from public, anon, authenticated;
revoke all on function public.list_agent_organization_members(uuid) from public, anon, authenticated;
revoke all on function public.upsert_agent_organization_membership(uuid,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.revoke_agent_organization_membership(uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.record_agent_federated_login(uuid,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.record_agent_federated_login(uuid,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.list_agent_account_memberships(uuid,text) to service_role;
grant execute on function public.resolve_agent_organization_membership(uuid,text,uuid) to service_role;
grant execute on function public.resolve_agent_federated_membership(uuid,text) to service_role;
grant execute on function public.list_agent_organization_members(uuid) to service_role;
grant execute on function public.upsert_agent_organization_membership(uuid,uuid,text,text,text) to service_role;
grant execute on function public.revoke_agent_organization_membership(uuid,uuid,text,text) to service_role;
grant execute on function public.record_agent_federated_login(uuid,uuid,text,text,text,text) to service_role;

create or replace function public.verify_agent_tenant_boundary(p_tenant_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_name text; v_slug text; v_status text; v_unique boolean;
begin
  select name,slug,status into v_name,v_slug,v_status from public.agent_tenants where id=p_tenant_id;
  if v_name is null then raise exception 'tenant not found'; end if;
  select exists (select 1 from pg_indexes where schemaname='public' and tablename='agent_identities' and indexname='agent_identities_token_sha256_global_uidx') into v_unique;
  return jsonb_build_object('tenantName',v_name,'tenantSlug',v_slug,'tenantStatus',v_status,'requestBound',true,'credentialGlobalUniqueness',v_unique,'organizationProvisioning',true,'tenantLifecycleEnforcement',true,'tenantOidcConnections',true,'managedSecretRotation',true,'organizationMemberships',true);
end;
$$;

revoke all on function public.verify_agent_tenant_boundary(uuid) from public, anon, authenticated;
grant execute on function public.verify_agent_tenant_boundary(uuid) to service_role;
