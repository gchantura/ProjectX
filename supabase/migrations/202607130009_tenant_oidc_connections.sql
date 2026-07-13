create table if not exists public.agent_oidc_connections (
  tenant_id uuid primary key references public.agent_tenants(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  issuer text not null check (issuer ~ '^https://[^[:space:]]+$' and char_length(issuer) <= 500),
  client_id text not null check (char_length(client_id) between 1 and 500),
  client_secret_ciphertext text not null check (client_secret_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  scopes text not null check (char_length(scopes) between 1 and 500),
  allowed_endpoint_origins jsonb not null default '[]'::jsonb check (jsonb_typeof(allowed_endpoint_origins)='array'),
  status text not null default 'active' check (status in ('active','disabled')),
  revision uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null check (char_length(updated_by) between 2 and 128)
);

create table if not exists public.agent_oidc_connection_events (
  tenant_id uuid not null references public.agent_tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  event_type text not null check (event_type in ('configured','rotated','disabled','enabled')),
  revision uuid not null,
  actor_id text not null check (char_length(actor_id) between 2 and 128),
  event_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (tenant_id,id)
);

create index if not exists agent_oidc_connection_events_tenant_idx on public.agent_oidc_connection_events (tenant_id,event_at desc);
alter table public.agent_oidc_connections enable row level security;
alter table public.agent_oidc_connection_events enable row level security;
revoke all on public.agent_oidc_connections, public.agent_oidc_connection_events from anon, authenticated;

create or replace function public.upsert_agent_oidc_connection(p_tenant_id uuid, p_connection jsonb, p_actor text)
returns jsonb language plpgsql security invoker set search_path=public,extensions as $$
declare
  v_existing public.agent_oidc_connections%rowtype;
  v_stored public.agent_oidc_connections%rowtype;
  v_event text;
begin
  if p_tenant_id is null
    or char_length(coalesce(p_connection->>'displayName','')) not between 1 and 80
    or coalesce(p_connection->>'issuer','') !~ '^https://[^[:space:]]+$'
    or char_length(coalesce(p_connection->>'clientId','')) not between 1 and 500
    or coalesce(p_connection->>'clientSecretCiphertext','') !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    or char_length(coalesce(p_connection->>'scopes','')) not between 1 and 500
    or jsonb_typeof(coalesce(p_connection->'allowedEndpointOrigins','[]'::jsonb)) <> 'array'
    or char_length(coalesce(p_actor,'')) not between 2 and 128 then
    raise exception 'invalid OIDC connection';
  end if;

  select * into v_existing from public.agent_oidc_connections where tenant_id=p_tenant_id for update;
  v_event := case when v_existing.tenant_id is null then 'configured' else 'rotated' end;

  insert into public.agent_oidc_connections (tenant_id,display_name,issuer,client_id,client_secret_ciphertext,scopes,allowed_endpoint_origins,status,revision,updated_by)
  values (p_tenant_id,p_connection->>'displayName',p_connection->>'issuer',p_connection->>'clientId',p_connection->>'clientSecretCiphertext',p_connection->>'scopes',coalesce(p_connection->'allowedEndpointOrigins','[]'::jsonb),'active',gen_random_uuid(),p_actor)
  on conflict (tenant_id) do update set
    display_name=excluded.display_name,issuer=excluded.issuer,client_id=excluded.client_id,
    client_secret_ciphertext=excluded.client_secret_ciphertext,scopes=excluded.scopes,
    allowed_endpoint_origins=excluded.allowed_endpoint_origins,status='active',revision=excluded.revision,
    updated_at=now(),updated_by=p_actor
  returning * into v_stored;

  insert into public.agent_oidc_connection_events (tenant_id,event_type,revision,actor_id,metadata)
  values (p_tenant_id,v_event,v_stored.revision,p_actor,jsonb_build_object('issuer',v_stored.issuer,'clientIdSha256',encode(digest(v_stored.client_id,'sha256'),'hex')));

  return jsonb_build_object('tenantId',v_stored.tenant_id,'displayName',v_stored.display_name,'issuer',v_stored.issuer,'clientId',v_stored.client_id,'scopes',v_stored.scopes,'allowedEndpointOrigins',v_stored.allowed_endpoint_origins,'status',v_stored.status,'revision',v_stored.revision,'createdAt',v_stored.created_at,'updatedAt',v_stored.updated_at,'secretConfigured',true);
end;
$$;

create or replace function public.set_agent_oidc_connection_status(p_tenant_id uuid, p_status text, p_actor text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_stored public.agent_oidc_connections%rowtype; v_event text;
begin
  if p_tenant_id is null or p_status not in ('active','disabled') or char_length(coalesce(p_actor,'')) not between 2 and 128 then raise exception 'invalid OIDC status change'; end if;
  update public.agent_oidc_connections set status=p_status,revision=gen_random_uuid(),updated_at=now(),updated_by=p_actor
  where tenant_id=p_tenant_id and status<>p_status returning * into v_stored;
  if v_stored.tenant_id is null then
    select * into v_stored from public.agent_oidc_connections where tenant_id=p_tenant_id;
    if v_stored.tenant_id is null then raise exception 'OIDC connection not found'; end if;
  else
    v_event := case when p_status='active' then 'enabled' else 'disabled' end;
    insert into public.agent_oidc_connection_events (tenant_id,event_type,revision,actor_id,metadata) values (p_tenant_id,v_event,v_stored.revision,p_actor,'{}'::jsonb);
  end if;
  return jsonb_build_object('tenantId',v_stored.tenant_id,'displayName',v_stored.display_name,'issuer',v_stored.issuer,'clientId',v_stored.client_id,'scopes',v_stored.scopes,'allowedEndpointOrigins',v_stored.allowed_endpoint_origins,'status',v_stored.status,'revision',v_stored.revision,'createdAt',v_stored.created_at,'updatedAt',v_stored.updated_at,'secretConfigured',true);
end;
$$;

revoke all on function public.upsert_agent_oidc_connection(uuid,jsonb,text) from public, anon, authenticated;
revoke all on function public.set_agent_oidc_connection_status(uuid,text,text) from public, anon, authenticated;
grant execute on function public.upsert_agent_oidc_connection(uuid,jsonb,text) to service_role;
grant execute on function public.set_agent_oidc_connection_status(uuid,text,text) to service_role;

create or replace function public.verify_agent_tenant_boundary(p_tenant_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_name text; v_slug text; v_status text; v_unique boolean;
begin
  select name,slug,status into v_name,v_slug,v_status from public.agent_tenants where id=p_tenant_id;
  if v_name is null then raise exception 'tenant not found'; end if;
  select exists (select 1 from pg_indexes where schemaname='public' and tablename='agent_identities' and indexname='agent_identities_token_sha256_global_uidx') into v_unique;
  return jsonb_build_object('tenantName',v_name,'tenantSlug',v_slug,'tenantStatus',v_status,'requestBound',true,'credentialGlobalUniqueness',v_unique,'organizationProvisioning',true,'tenantLifecycleEnforcement',true,'tenantOidcConnections',true);
end;
$$;

revoke all on function public.verify_agent_tenant_boundary(uuid) from public, anon, authenticated;
grant execute on function public.verify_agent_tenant_boundary(uuid) to service_role;
