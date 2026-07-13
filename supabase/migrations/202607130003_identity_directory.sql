create table if not exists public.agent_identities (
  tenant_id uuid not null references public.agent_tenants(id) on delete cascade,
  id text not null check (id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:@-]{1,127}$'),
  display_name text not null check (char_length(display_name) between 1 and 160),
  role text not null check (role in ('viewer','operator','admin')),
  token_sha256 text not null check (token_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'active' check (status in ('active','revoked')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_by text,
  revoked_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, token_sha256)
);

create table if not exists public.agent_identity_events (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  identity_id text not null,
  event_type text not null check (event_type in ('created','role_changed','token_rotated','revoked','federated_login')),
  actor_id text not null,
  event_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (tenant_id, id),
  foreign key (tenant_id, identity_id) references public.agent_identities(tenant_id, id) on delete cascade
);

create index if not exists agent_identities_active_idx on public.agent_identities (tenant_id, status, updated_at desc);
create index if not exists agent_identity_events_identity_idx on public.agent_identity_events (tenant_id, identity_id, event_at desc);
alter table public.agent_identities enable row level security;
alter table public.agent_identity_events enable row level security;
revoke all on public.agent_identities, public.agent_identity_events from anon, authenticated;

create or replace function public.upsert_agent_identity(p_tenant_id uuid, p_identity jsonb, p_actor text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_existing public.agent_identities%rowtype; v_stored public.agent_identities%rowtype; v_event text;
begin
  if p_tenant_id is null or coalesce(p_identity->>'id','') !~ '^[a-zA-Z0-9][a-zA-Z0-9._:@-]{1,127}$'
    or char_length(coalesce(p_identity->>'displayName','')) not between 1 and 160
    or coalesce(p_identity->>'role','') not in ('viewer','operator','admin')
    or coalesce(p_identity->>'tokenSha256','') !~ '^[a-f0-9]{64}$'
    or char_length(coalesce(p_actor,'')) not between 1 and 160 then raise exception 'invalid identity'; end if;
  select * into v_existing from public.agent_identities where tenant_id=p_tenant_id and id=p_identity->>'id' for update;
  insert into public.agent_identities (tenant_id,id,display_name,role,token_sha256,status,created_by,created_at,updated_at,revoked_by,revoked_at)
  values (p_tenant_id,p_identity->>'id',p_identity->>'displayName',p_identity->>'role',p_identity->>'tokenSha256','active',p_actor,now(),now(),null,null)
  on conflict (tenant_id,id) do update set display_name=excluded.display_name,role=excluded.role,token_sha256=excluded.token_sha256,
    status='active',updated_at=now(),revoked_by=null,revoked_at=null returning * into v_stored;
  v_event := case when v_existing.id is null then 'created' when v_existing.token_sha256 <> v_stored.token_sha256 then 'token_rotated' else 'role_changed' end;
  insert into public.agent_identity_events (tenant_id,identity_id,event_type,actor_id,metadata)
  values (p_tenant_id,v_stored.id,v_event,p_actor,jsonb_build_object('role',v_stored.role));
  return jsonb_build_object('id',v_stored.id,'displayName',v_stored.display_name,'role',v_stored.role,'status',v_stored.status,
    'createdAt',v_stored.created_at,'updatedAt',v_stored.updated_at);
end;
$$;

create or replace function public.revoke_agent_identity(p_tenant_id uuid, p_identity_id text, p_actor text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_stored public.agent_identities%rowtype;
begin
  update public.agent_identities set status='revoked',revoked_by=p_actor,revoked_at=now(),updated_at=now()
  where tenant_id=p_tenant_id and id=p_identity_id and status='active' returning * into v_stored;
  if v_stored.id is null then return jsonb_build_object('revoked',false,'id',p_identity_id); end if;
  insert into public.agent_identity_events (tenant_id,identity_id,event_type,actor_id) values (p_tenant_id,v_stored.id,'revoked',p_actor);
  return jsonb_build_object('revoked',true,'id',v_stored.id,'status',v_stored.status,'revokedAt',v_stored.revoked_at);
end;
$$;

revoke all on function public.upsert_agent_identity(uuid,jsonb,text) from public, anon, authenticated;
revoke all on function public.revoke_agent_identity(uuid,text,text) from public, anon, authenticated;
grant execute on function public.upsert_agent_identity(uuid,jsonb,text) to service_role;
grant execute on function public.revoke_agent_identity(uuid,text,text) to service_role;

create or replace function public.record_agent_federated_login(p_tenant_id uuid, p_identity_id text, p_actor text, p_issuer text, p_subject_sha256 text)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if p_subject_sha256 !~ '^[a-f0-9]{64}$' or char_length(coalesce(p_issuer,'')) not between 1 and 500 then raise exception 'invalid federated login evidence'; end if;
  if not exists (select 1 from public.agent_identities where tenant_id=p_tenant_id and id=p_identity_id and status='active') then raise exception 'active identity not found'; end if;
  insert into public.agent_identity_events (tenant_id,identity_id,event_type,actor_id,metadata)
  values (p_tenant_id,p_identity_id,'federated_login',p_actor,jsonb_build_object('issuer',p_issuer,'subjectSha256',p_subject_sha256));
end;
$$;

revoke all on function public.record_agent_federated_login(uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.record_agent_federated_login(uuid,text,text,text,text) to service_role;
