create extension if not exists pgcrypto;

create table if not exists public.agent_tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 160),
  created_at timestamptz not null default now()
);

create table if not exists public.agent_runs (
  tenant_id uuid not null references public.agent_tenants(id) on delete cascade,
  id text not null check (id ~ '^run-[a-zA-Z0-9-]+$'),
  task text not null,
  status text not null check (status in ('running','completed','verified','needs_attention','stopped')),
  provider text not null,
  model text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  run_json jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

create table if not exists public.agent_run_events (
  tenant_id uuid not null,
  run_id text not null,
  position integer not null check (position >= 0),
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, run_id, position),
  foreign key (tenant_id, run_id) references public.agent_runs(tenant_id, id) on delete cascade
);

create table if not exists public.agent_memories (
  tenant_id uuid not null references public.agent_tenants(id) on delete cascade,
  id text not null check (id ~ '^mem-[a-zA-Z0-9-]+$'),
  scope text not null,
  kind text not null,
  content text not null check (char_length(content) between 1 and 4000),
  tags jsonb not null default '[]'::jsonb,
  importance double precision not null check (importance >= 0 and importance <= 1),
  source_run_id text,
  memory_json jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, source_run_id)
);

create index if not exists agent_runs_tenant_started_idx on public.agent_runs (tenant_id, started_at desc);
create index if not exists agent_runs_tenant_status_idx on public.agent_runs (tenant_id, status, started_at desc);
create index if not exists agent_run_events_run_idx on public.agent_run_events (tenant_id, run_id, position);
create index if not exists agent_memories_scope_updated_idx on public.agent_memories (tenant_id, scope, importance desc, updated_at desc);
create index if not exists agent_memories_expiry_idx on public.agent_memories (tenant_id, expires_at);

alter table public.agent_tenants enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_run_events enable row level security;
alter table public.agent_memories enable row level security;
revoke all on public.agent_tenants, public.agent_runs, public.agent_run_events, public.agent_memories from anon, authenticated;

create or replace function public.persist_agent_run(p_tenant_id uuid, p_run jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare
  v_id text := p_run->>'id';
  v_started_at timestamptz := (p_run->>'startedAt')::timestamptz;
begin
  if p_tenant_id is null or v_id is null or v_id !~ '^run-[a-zA-Z0-9-]+$' then
    raise exception 'invalid tenant or run id';
  end if;
  insert into public.agent_runs (tenant_id,id,task,status,provider,model,started_at,completed_at,run_json,updated_at)
  values (p_tenant_id,v_id,p_run->>'task',p_run->>'status',p_run#>>'{config,provider}',p_run#>>'{config,model}',v_started_at,
    nullif(coalesce(p_run->>'endedAt', p_run->>'completedAt'),'')::timestamptz,p_run,now())
  on conflict (tenant_id,id) do update set task=excluded.task,status=excluded.status,provider=excluded.provider,
    model=excluded.model,completed_at=excluded.completed_at,run_json=excluded.run_json,updated_at=now();
end;
$$;

revoke all on function public.persist_agent_run(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.persist_agent_run(uuid,jsonb) to service_role;

create or replace function public.persist_agent_memory(p_tenant_id uuid, p_memory jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_id text := p_memory->>'id';
  v_source_run_id text := nullif(p_memory->>'sourceRunId','');
  v_created_at timestamptz := (p_memory->>'createdAt')::timestamptz;
  v_updated_at timestamptz := coalesce(nullif(p_memory->>'updatedAt','')::timestamptz, v_created_at);
  v_expires_at timestamptz := nullif(p_memory->>'expiresAt','')::timestamptz;
  v_existing jsonb;
begin
  if p_tenant_id is null or v_id is null or v_id !~ '^mem-[a-zA-Z0-9-]+$' then
    raise exception 'invalid tenant or memory id';
  end if;
  if v_source_run_id is not null then
    select memory_json into v_existing from public.agent_memories where tenant_id = p_tenant_id and source_run_id = v_source_run_id;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;
  insert into public.agent_memories (tenant_id,id,scope,kind,content,tags,importance,source_run_id,memory_json,created_at,updated_at,expires_at)
  values (p_tenant_id,v_id,p_memory->>'scope',p_memory->>'kind',p_memory->>'content',coalesce(p_memory->'tags','[]'::jsonb),
    coalesce((p_memory->>'importance')::double precision,0.5),v_source_run_id,p_memory,v_created_at,v_updated_at,v_expires_at)
  on conflict (tenant_id,id) do update set scope=excluded.scope,kind=excluded.kind,content=excluded.content,tags=excluded.tags,
    importance=excluded.importance,source_run_id=excluded.source_run_id,memory_json=excluded.memory_json,updated_at=now(),expires_at=excluded.expires_at
  returning memory_json into v_existing;
  return v_existing;
end;
$$;

revoke all on function public.persist_agent_memory(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.persist_agent_memory(uuid,jsonb) to service_role;
