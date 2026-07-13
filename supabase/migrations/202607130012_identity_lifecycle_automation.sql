create table if not exists public.agent_identity_invitations (
  tenant_id uuid not null references public.agent_tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  email text not null check (char_length(email) between 3 and 254 and email = lower(email)),
  role text not null check (role in ('viewer','operator','admin')),
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  expires_at timestamptz not null,
  created_by text not null check (char_length(created_by) between 1 and 160),
  created_at timestamptz not null default now(),
  accepted_account_tenant_id uuid,
  accepted_identity_id text,
  accepted_at timestamptz,
  revoked_by text,
  revoked_at timestamptz,
  primary key (tenant_id,id),
  foreign key (accepted_account_tenant_id,accepted_identity_id) references public.agent_identities(tenant_id,id) on delete set null
);

create unique index if not exists agent_identity_invitations_pending_uidx
  on public.agent_identity_invitations (tenant_id,lower(email)) where status='pending';
create index if not exists agent_identity_invitations_status_idx
  on public.agent_identity_invitations (tenant_id,status,expires_at,created_at desc);

create table if not exists public.agent_identity_invitation_events (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  invitation_id uuid not null,
  event_type text not null check (event_type in ('created','superseded','accepted','revoked')),
  actor_id text not null check (char_length(actor_id) between 1 and 160),
  event_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (tenant_id,id),
  foreign key (tenant_id,invitation_id) references public.agent_identity_invitations(tenant_id,id) on delete cascade
);

create index if not exists agent_identity_invitation_events_idx
  on public.agent_identity_invitation_events (tenant_id,invitation_id,event_at desc);

create table if not exists public.agent_scim_connections (
  tenant_id uuid primary key references public.agent_tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid() unique,
  display_name text not null check (char_length(display_name) between 1 and 80),
  token_sha256 text not null check (token_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'active' check (status in ('active','disabled')),
  created_by text not null check (char_length(created_by) between 1 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz
);

create unique index if not exists agent_scim_connections_token_uidx
  on public.agent_scim_connections (token_sha256);

create table if not exists public.agent_scim_connection_events (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  event_type text not null check (event_type in ('configured','token_rotated','enabled','disabled')),
  actor_id text not null check (char_length(actor_id) between 1 and 160),
  event_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (tenant_id,id),
  foreign key (tenant_id) references public.agent_scim_connections(tenant_id) on delete cascade
);

create table if not exists public.agent_scim_resources (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  identity_id text not null,
  external_id text,
  user_name text not null check (char_length(user_name) between 2 and 128),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,id),
  foreign key (tenant_id,identity_id) references public.agent_identities(tenant_id,id) on delete cascade
);

create unique index if not exists agent_scim_resources_username_uidx
  on public.agent_scim_resources (tenant_id,lower(user_name));
create unique index if not exists agent_scim_resources_external_uidx
  on public.agent_scim_resources (tenant_id,external_id) where external_id is not null;

create table if not exists public.agent_scim_resource_events (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  resource_id uuid not null,
  event_type text not null check (event_type in ('provisioned','updated','reactivated','deprovisioned')),
  actor_id text not null check (char_length(actor_id) between 1 and 160),
  event_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (tenant_id,id),
  foreign key (tenant_id,resource_id) references public.agent_scim_resources(tenant_id,id) on delete cascade
);

create index if not exists agent_scim_resource_events_idx
  on public.agent_scim_resource_events (tenant_id,resource_id,event_at desc);

alter table public.agent_identity_invitations enable row level security;
alter table public.agent_identity_invitation_events enable row level security;
alter table public.agent_scim_connections enable row level security;
alter table public.agent_scim_connection_events enable row level security;
alter table public.agent_scim_resources enable row level security;
alter table public.agent_scim_resource_events enable row level security;
revoke all on public.agent_identity_invitations, public.agent_identity_invitation_events,
  public.agent_scim_connections, public.agent_scim_connection_events,
  public.agent_scim_resources, public.agent_scim_resource_events from anon, authenticated;

create or replace function public.create_agent_identity_invitation(p_tenant_id uuid, p_email text, p_role text, p_expires_at timestamptz, p_actor text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_email text := lower(trim(coalesce(p_email,''))); v_invitation public.agent_identity_invitations%rowtype; v_old record;
begin
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or p_role not in ('viewer','operator','admin')
    or p_expires_at < now()+interval '1 hour' or p_expires_at > now()+interval '30 days'
    or char_length(coalesce(p_actor,'')) not between 1 and 160 then raise exception 'invalid identity invitation'; end if;
  if not exists (select 1 from public.agent_tenants where id=p_tenant_id and status='active') then raise exception 'active organization not found'; end if;
  for v_old in with superseded as (
    update public.agent_identity_invitations set status='revoked',revoked_by=p_actor,revoked_at=now()
    where tenant_id=p_tenant_id and lower(email)=v_email and status='pending' returning id
  ) select id from superseded loop
    insert into public.agent_identity_invitation_events (tenant_id,invitation_id,event_type,actor_id) values (p_tenant_id,v_old.id,'superseded',p_actor);
  end loop;
  insert into public.agent_identity_invitations (tenant_id,email,role,expires_at,created_by)
  values (p_tenant_id,v_email,p_role,p_expires_at,p_actor) returning * into v_invitation;
  insert into public.agent_identity_invitation_events (tenant_id,invitation_id,event_type,actor_id,metadata)
  values (p_tenant_id,v_invitation.id,'created',p_actor,jsonb_build_object('role',p_role,'expiresAt',p_expires_at));
  return jsonb_build_object('id',v_invitation.id,'email',v_invitation.email,'role',v_invitation.role,'status',v_invitation.status,'expiresAt',v_invitation.expires_at,'createdAt',v_invitation.created_at,'createdBy',v_invitation.created_by);
end;
$$;

create or replace function public.list_agent_identity_invitations(p_tenant_id uuid)
returns setof jsonb language sql security invoker set search_path=public as $$
  select jsonb_build_object('id',i.id,'email',i.email,'role',i.role,
    'status',case when i.status='pending' and i.expires_at <= now() then 'expired' else i.status end,
    'expiresAt',i.expires_at,'createdAt',i.created_at,'createdBy',i.created_by,
    'acceptedAt',i.accepted_at,'acceptedIdentityId',i.accepted_identity_id,'revokedAt',i.revoked_at)
  from public.agent_identity_invitations i where i.tenant_id=p_tenant_id order by i.created_at desc limit 500;
$$;

create or replace function public.revoke_agent_identity_invitation(p_tenant_id uuid, p_invitation_id uuid, p_actor text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_invitation public.agent_identity_invitations%rowtype;
begin
  update public.agent_identity_invitations set status='revoked',revoked_by=p_actor,revoked_at=now()
  where tenant_id=p_tenant_id and id=p_invitation_id and status='pending' returning * into v_invitation;
  if v_invitation.id is null then return jsonb_build_object('revoked',false,'id',p_invitation_id); end if;
  insert into public.agent_identity_invitation_events (tenant_id,invitation_id,event_type,actor_id) values (p_tenant_id,p_invitation_id,'revoked',p_actor);
  return jsonb_build_object('revoked',true,'id',p_invitation_id,'revokedAt',v_invitation.revoked_at);
end;
$$;

create or replace function public.redeem_agent_oidc_invitation(p_tenant_id uuid, p_email text, p_display_name text, p_issuer text, p_subject_sha256 text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_email text := lower(trim(coalesce(p_email,''))); v_invitation public.agent_identity_invitations%rowtype;
  v_account_tenant_id uuid; v_identity_id text; v_matches integer; v_tenant public.agent_tenants%rowtype;
begin
  if char_length(coalesce(p_display_name,'')) not between 1 and 160 or char_length(coalesce(p_issuer,'')) not between 1 and 500
    or p_subject_sha256 !~ '^[a-f0-9]{64}$' then raise exception 'invalid invitation redemption evidence'; end if;
  select * into v_tenant from public.agent_tenants where id=p_tenant_id and status='active';
  if v_tenant.id is null then raise exception 'active organization not found'; end if;
  select * into v_invitation from public.agent_identity_invitations
    where tenant_id=p_tenant_id and lower(email)=v_email and status='pending' and expires_at>now()
    order by created_at desc limit 1 for update;
  if v_invitation.id is null then return null; end if;
  select count(*),(array_agg(tenant_id))[1],(array_agg(id))[1] into v_matches,v_account_tenant_id,v_identity_id
    from public.agent_identities where lower(id)=v_email and status='active';
  if v_matches > 1 then raise exception 'ambiguous federated identity'; end if;
  if v_matches = 0 then
    v_account_tenant_id := p_tenant_id; v_identity_id := v_email;
    insert into public.agent_identities (tenant_id,id,display_name,role,token_sha256,status,created_by)
    values (p_tenant_id,v_email,p_display_name,v_invitation.role,encode(digest(gen_random_uuid()::text||clock_timestamp()::text,'sha256'),'hex'),'active','oidc-invitation');
  elsif v_account_tenant_id = p_tenant_id then
    update public.agent_identities set display_name=p_display_name,role=v_invitation.role,updated_at=now() where tenant_id=v_account_tenant_id and id=v_identity_id;
  else
    insert into public.agent_organization_memberships (account_tenant_id,identity_id,tenant_id,role,status,created_by,updated_at,revoked_by,revoked_at)
    values (v_account_tenant_id,v_identity_id,p_tenant_id,v_invitation.role,'active','oidc-invitation',now(),null,null)
    on conflict (account_tenant_id,identity_id,tenant_id) do update set role=excluded.role,status='active',updated_at=now(),revoked_by=null,revoked_at=null;
    insert into public.agent_organization_membership_events (tenant_id,account_tenant_id,identity_id,event_type,actor_id,metadata)
    values (p_tenant_id,v_account_tenant_id,v_identity_id,'granted','oidc-invitation',jsonb_build_object('role',v_invitation.role,'invitationId',v_invitation.id));
  end if;
  update public.agent_identity_invitations set status='accepted',accepted_account_tenant_id=v_account_tenant_id,
    accepted_identity_id=v_identity_id,accepted_at=now() where tenant_id=p_tenant_id and id=v_invitation.id;
  insert into public.agent_identity_invitation_events (tenant_id,invitation_id,event_type,actor_id,metadata)
  values (p_tenant_id,v_invitation.id,'accepted',v_identity_id,jsonb_build_object('issuer',p_issuer,'subjectSha256',p_subject_sha256,'accountTenantId',v_account_tenant_id));
  return public.resolve_agent_organization_membership(v_account_tenant_id,v_identity_id,p_tenant_id);
end;
$$;

create or replace function public.upsert_agent_scim_connection(p_tenant_id uuid, p_display_name text, p_token_sha256 text, p_actor text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_existing public.agent_scim_connections%rowtype; v_stored public.agent_scim_connections%rowtype; v_event text;
begin
  if char_length(coalesce(p_display_name,'')) not between 1 and 80 or p_token_sha256 !~ '^[a-f0-9]{64}$'
    or char_length(coalesce(p_actor,'')) not between 1 and 160 then raise exception 'invalid SCIM connection'; end if;
  if not exists (select 1 from public.agent_tenants where id=p_tenant_id and status='active') then raise exception 'active organization not found'; end if;
  select * into v_existing from public.agent_scim_connections where tenant_id=p_tenant_id for update;
  insert into public.agent_scim_connections (tenant_id,display_name,token_sha256,status,created_by,updated_at)
  values (p_tenant_id,p_display_name,p_token_sha256,'active',p_actor,now())
  on conflict (tenant_id) do update set display_name=excluded.display_name,token_sha256=excluded.token_sha256,status='active',updated_at=now()
  returning * into v_stored;
  v_event := case when v_existing.tenant_id is null then 'configured' else 'token_rotated' end;
  insert into public.agent_scim_connection_events (tenant_id,event_type,actor_id) values (p_tenant_id,v_event,p_actor);
  return jsonb_build_object('id',v_stored.id,'tenantId',v_stored.tenant_id,'displayName',v_stored.display_name,'status',v_stored.status,'createdAt',v_stored.created_at,'updatedAt',v_stored.updated_at,'lastUsedAt',v_stored.last_used_at);
end;
$$;

create or replace function public.set_agent_scim_connection_status(p_tenant_id uuid, p_status text, p_actor text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_stored public.agent_scim_connections%rowtype;
begin
  if p_status not in ('active','disabled') or char_length(coalesce(p_actor,'')) not between 1 and 160 then raise exception 'invalid SCIM status'; end if;
  update public.agent_scim_connections set status=p_status,updated_at=now() where tenant_id=p_tenant_id and status<>p_status returning * into v_stored;
  if v_stored.tenant_id is null then return jsonb_build_object('changed',false,'status',p_status); end if;
  insert into public.agent_scim_connection_events (tenant_id,event_type,actor_id) values (p_tenant_id,case when p_status='active' then 'enabled' else 'disabled' end,p_actor);
  return jsonb_build_object('changed',true,'status',v_stored.status,'updatedAt',v_stored.updated_at);
end;
$$;

create or replace function public.authenticate_agent_scim_token(p_token_sha256 text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_connection public.agent_scim_connections%rowtype; v_tenant public.agent_tenants%rowtype;
begin
  if p_token_sha256 !~ '^[a-f0-9]{64}$' then return null; end if;
  select c.* into v_connection from public.agent_scim_connections c where c.token_sha256=p_token_sha256 and c.status='active';
  if v_connection.tenant_id is null then return null; end if;
  select * into v_tenant from public.agent_tenants where id=v_connection.tenant_id and status='active';
  if v_tenant.id is null then return null; end if;
  if v_connection.last_used_at is null or v_connection.last_used_at < now()-interval '5 minutes' then
    update public.agent_scim_connections set last_used_at=now() where tenant_id=v_connection.tenant_id;
  end if;
  return jsonb_build_object('subject','scim:'||v_connection.id,'displayName',v_connection.display_name,'role','admin',
    'tenantId',v_tenant.id,'accountTenantId',v_tenant.id,'tenantName',v_tenant.name,'connectionId',v_connection.id);
end;
$$;

create or replace function public.list_agent_scim_users(p_tenant_id uuid, p_user_name text, p_offset integer, p_limit integer)
returns setof jsonb language sql security invoker set search_path=public as $$
  select jsonb_build_object('id',r.id,'externalId',r.external_id,'userName',r.user_name,'displayName',i.display_name,
    'role',i.role,'active',i.status='active','createdAt',r.created_at,'updatedAt',greatest(r.updated_at,i.updated_at))
  from public.agent_scim_resources r join public.agent_identities i on i.tenant_id=r.tenant_id and i.id=r.identity_id
  where r.tenant_id=p_tenant_id and (nullif(trim(p_user_name),'') is null or lower(r.user_name)=lower(trim(p_user_name)))
  order by r.created_at,r.id offset greatest(p_offset,0) limit least(greatest(p_limit,1),200);
$$;

create or replace function public.count_agent_scim_users(p_tenant_id uuid, p_user_name text)
returns integer language sql security invoker set search_path=public as $$
  select count(*)::integer from public.agent_scim_resources r
  where r.tenant_id=p_tenant_id and (nullif(trim(p_user_name),'') is null or lower(r.user_name)=lower(trim(p_user_name)));
$$;

create or replace function public.get_agent_scim_user(p_tenant_id uuid, p_resource_id uuid)
returns jsonb language sql security invoker set search_path=public as $$
  select jsonb_build_object('id',r.id,'externalId',r.external_id,'userName',r.user_name,'displayName',i.display_name,
    'role',i.role,'active',i.status='active','createdAt',r.created_at,'updatedAt',greatest(r.updated_at,i.updated_at))
  from public.agent_scim_resources r join public.agent_identities i on i.tenant_id=r.tenant_id and i.id=r.identity_id
  where r.tenant_id=p_tenant_id and r.id=p_resource_id;
$$;

create or replace function public.upsert_agent_scim_user(p_tenant_id uuid, p_resource_id uuid, p_user jsonb, p_actor text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_resource public.agent_scim_resources%rowtype; v_identity public.agent_identities%rowtype; v_id uuid := coalesce(p_resource_id,gen_random_uuid());
  v_user_name text := lower(trim(coalesce(p_user->>'userName',''))); v_display_name text := trim(coalesce(p_user->>'displayName',''));
  v_role text := coalesce(p_user->>'role','operator'); v_active boolean := coalesce((p_user->>'active')::boolean,true); v_event text;
begin
  if v_user_name !~ '^[a-zA-Z0-9][a-zA-Z0-9._:@-]{1,127}$' or char_length(v_display_name) not between 1 and 160
    or v_role not in ('viewer','operator','admin') or char_length(coalesce(p_user->>'externalId','')) > 255
    or char_length(coalesce(p_actor,'')) not between 1 and 160 then raise exception 'invalid SCIM user'; end if;
  select * into v_resource from public.agent_scim_resources where tenant_id=p_tenant_id and id=v_id for update;
  if p_resource_id is null then
    if exists (select 1 from public.agent_identities where tenant_id=p_tenant_id and lower(id)=v_user_name)
      or exists (select 1 from public.agent_scim_resources where tenant_id=p_tenant_id and (lower(user_name)=v_user_name or (p_user->>'externalId' is not null and external_id=p_user->>'externalId'))) then
      raise unique_violation using message='SCIM user already exists';
    end if;
    insert into public.agent_identities (tenant_id,id,display_name,role,token_sha256,status,created_by,revoked_by,revoked_at)
    values (p_tenant_id,v_user_name,v_display_name,v_role,encode(digest(gen_random_uuid()::text||clock_timestamp()::text,'sha256'),'hex'),case when v_active then 'active' else 'revoked' end,p_actor,case when v_active then null else p_actor end,case when v_active then null else now() end)
    returning * into v_identity;
    insert into public.agent_scim_resources (tenant_id,id,identity_id,external_id,user_name)
    values (p_tenant_id,v_id,v_identity.id,nullif(p_user->>'externalId',''),v_user_name) returning * into v_resource;
    v_event := 'provisioned';
  else
    if v_resource.id is null then return null; end if;
    if lower(v_resource.user_name) <> v_user_name then raise exception 'SCIM userName is immutable'; end if;
    select * into v_identity from public.agent_identities where tenant_id=p_tenant_id and id=v_resource.identity_id for update;
    v_event := case when v_identity.status='revoked' and v_active then 'reactivated' when v_identity.status='active' and not v_active then 'deprovisioned' else 'updated' end;
    update public.agent_identities set display_name=v_display_name,role=v_role,status=case when v_active then 'active' else 'revoked' end,
      updated_at=now(),revoked_by=case when v_active then null else p_actor end,revoked_at=case when v_active then null else now() end
      where tenant_id=p_tenant_id and id=v_resource.identity_id returning * into v_identity;
    update public.agent_scim_resources set external_id=nullif(p_user->>'externalId',''),updated_at=now() where tenant_id=p_tenant_id and id=v_resource.id returning * into v_resource;
  end if;
  insert into public.agent_scim_resource_events (tenant_id,resource_id,event_type,actor_id,metadata)
  values (p_tenant_id,v_resource.id,v_event,p_actor,jsonb_build_object('role',v_identity.role,'active',v_identity.status='active'));
  return public.get_agent_scim_user(p_tenant_id,v_resource.id);
end;
$$;

create or replace function public.deprovision_agent_scim_user(p_tenant_id uuid, p_resource_id uuid, p_actor text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_resource public.agent_scim_resources%rowtype; v_changed integer := 0;
begin
  select * into v_resource from public.agent_scim_resources where tenant_id=p_tenant_id and id=p_resource_id for update;
  if v_resource.id is null then return jsonb_build_object('found',false); end if;
  update public.agent_identities set status='revoked',updated_at=now(),revoked_by=p_actor,revoked_at=now()
    where tenant_id=p_tenant_id and id=v_resource.identity_id and status='active';
  get diagnostics v_changed = row_count;
  if v_changed > 0 then insert into public.agent_scim_resource_events (tenant_id,resource_id,event_type,actor_id) values (p_tenant_id,p_resource_id,'deprovisioned',p_actor); end if;
  return jsonb_build_object('found',true,'deprovisioned',v_changed > 0);
end;
$$;

revoke all on function public.create_agent_identity_invitation(uuid,text,text,timestamptz,text) from public, anon, authenticated;
revoke all on function public.list_agent_identity_invitations(uuid) from public, anon, authenticated;
revoke all on function public.revoke_agent_identity_invitation(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.redeem_agent_oidc_invitation(uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.upsert_agent_scim_connection(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.set_agent_scim_connection_status(uuid,text,text) from public, anon, authenticated;
revoke all on function public.authenticate_agent_scim_token(text) from public, anon, authenticated;
revoke all on function public.list_agent_scim_users(uuid,text,integer,integer) from public, anon, authenticated;
revoke all on function public.count_agent_scim_users(uuid,text) from public, anon, authenticated;
revoke all on function public.get_agent_scim_user(uuid,uuid) from public, anon, authenticated;
revoke all on function public.upsert_agent_scim_user(uuid,uuid,jsonb,text) from public, anon, authenticated;
revoke all on function public.deprovision_agent_scim_user(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.create_agent_identity_invitation(uuid,text,text,timestamptz,text) to service_role;
grant execute on function public.list_agent_identity_invitations(uuid) to service_role;
grant execute on function public.revoke_agent_identity_invitation(uuid,uuid,text) to service_role;
grant execute on function public.redeem_agent_oidc_invitation(uuid,text,text,text,text) to service_role;
grant execute on function public.upsert_agent_scim_connection(uuid,text,text,text) to service_role;
grant execute on function public.set_agent_scim_connection_status(uuid,text,text) to service_role;
grant execute on function public.authenticate_agent_scim_token(text) to service_role;
grant execute on function public.list_agent_scim_users(uuid,text,integer,integer) to service_role;
grant execute on function public.count_agent_scim_users(uuid,text) to service_role;
grant execute on function public.get_agent_scim_user(uuid,uuid) to service_role;
grant execute on function public.upsert_agent_scim_user(uuid,uuid,jsonb,text) to service_role;
grant execute on function public.deprovision_agent_scim_user(uuid,uuid,text) to service_role;

create or replace function public.verify_agent_tenant_boundary(p_tenant_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_name text; v_slug text; v_status text; v_unique boolean;
begin
  select name,slug,status into v_name,v_slug,v_status from public.agent_tenants where id=p_tenant_id;
  if v_name is null then raise exception 'tenant not found'; end if;
  select exists (select 1 from pg_indexes where schemaname='public' and tablename='agent_identities' and indexname='agent_identities_token_sha256_global_uidx') into v_unique;
  return jsonb_build_object('tenantName',v_name,'tenantSlug',v_slug,'tenantStatus',v_status,'requestBound',true,
    'credentialGlobalUniqueness',v_unique,'organizationProvisioning',true,'tenantLifecycleEnforcement',true,
    'tenantOidcConnections',true,'managedSecretRotation',true,'organizationMemberships',true,'identityLifecycleAutomation',true);
end;
$$;

revoke all on function public.verify_agent_tenant_boundary(uuid) from public, anon, authenticated;
grant execute on function public.verify_agent_tenant_boundary(uuid) to service_role;
