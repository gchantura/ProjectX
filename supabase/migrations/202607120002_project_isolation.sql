create table if not exists public.agent_projects (
  tenant_id uuid not null references public.agent_tenants(id) on delete cascade,
  id text not null check (id ~ '^project-[a-zA-Z0-9-]+$'),
  name text not null check (char_length(name) between 1 and 160),
  kind text not null default 'repository' check (kind in ('repository','local','imported')),
  status text not null default 'ready' check (status in ('ready','indexing','degraded','archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

alter table public.agent_projects enable row level security;
revoke all on public.agent_projects from anon, authenticated;

alter table public.agent_runs add column if not exists project_id text;
alter table public.agent_run_events add column if not exists project_id text;
alter table public.agent_memories add column if not exists project_id text;

insert into public.agent_projects (tenant_id,id,name,kind,status,metadata)
select id, 'project-legacy-' || replace(id::text, '-', ''), 'Legacy imported workspace', 'imported', 'ready', jsonb_build_object('migration','202607120002')
from public.agent_tenants
on conflict (tenant_id,id) do nothing;

update public.agent_runs
set project_id = 'project-legacy-' || replace(tenant_id::text, '-', '')
where project_id is null;

update public.agent_run_events e
set project_id = r.project_id
from public.agent_runs r
where e.tenant_id = r.tenant_id and e.run_id = r.id and e.project_id is null;

update public.agent_memories
set project_id = coalesce(nullif(memory_json->>'projectId',''), 'project-legacy-' || replace(tenant_id::text, '-', ''))
where project_id is null;

alter table public.agent_runs alter column project_id set not null;
alter table public.agent_run_events alter column project_id set not null;
alter table public.agent_memories alter column project_id set not null;

do $$ begin
  alter table public.agent_runs add constraint agent_runs_project_fk foreign key (tenant_id,project_id) references public.agent_projects(tenant_id,id) on delete cascade;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.agent_run_events add constraint agent_run_events_project_fk foreign key (tenant_id,project_id) references public.agent_projects(tenant_id,id) on delete cascade;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.agent_memories add constraint agent_memories_project_fk foreign key (tenant_id,project_id) references public.agent_projects(tenant_id,id) on delete cascade;
exception when duplicate_object then null; end $$;

alter table public.agent_memories drop constraint if exists agent_memories_tenant_id_source_run_id_key;
create unique index if not exists agent_memories_project_source_run_idx on public.agent_memories (tenant_id,project_id,source_run_id) where source_run_id is not null;
create index if not exists agent_runs_project_started_idx on public.agent_runs (tenant_id,project_id,started_at desc);
create index if not exists agent_run_events_project_run_idx on public.agent_run_events (tenant_id,project_id,run_id,position);
create index if not exists agent_memories_project_updated_idx on public.agent_memories (tenant_id,project_id,importance desc,updated_at desc);

create or replace function public.persist_agent_project(p_tenant_id uuid, p_project jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare
  v_id text := p_project->>'id';
begin
  if p_tenant_id is null or v_id is null or v_id !~ '^project-[a-zA-Z0-9-]+$' then raise exception 'invalid tenant or project id'; end if;
  insert into public.agent_projects (tenant_id,id,name,kind,status,metadata,updated_at)
  values (p_tenant_id,v_id,left(coalesce(nullif(p_project->>'name',''),'Unnamed project'),160),
    case when p_project->>'kind' in ('repository','local','imported') then p_project->>'kind' else 'repository' end,
    'ready', jsonb_build_object('source','kcevagent-server'), now())
  on conflict (tenant_id,id) do update set name=excluded.name,kind=excluded.kind,status=excluded.status,updated_at=now();
end;
$$;

revoke all on function public.persist_agent_project(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.persist_agent_project(uuid,jsonb) to service_role;

create or replace function public.persist_agent_run(p_tenant_id uuid, p_run jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare
  v_id text := p_run->>'id';
  v_project_id text := p_run#>>'{config,projectId}';
  v_started_at timestamptz := (p_run->>'startedAt')::timestamptz;
begin
  if p_tenant_id is null or v_id is null or v_id !~ '^run-[a-zA-Z0-9-]+$' or v_project_id is null or v_project_id !~ '^project-[a-zA-Z0-9-]+$' then
    raise exception 'invalid tenant, project, or run id';
  end if;
  if not exists (select 1 from public.agent_projects where tenant_id=p_tenant_id and id=v_project_id) then raise exception 'project not registered'; end if;
  insert into public.agent_runs (tenant_id,project_id,id,task,status,provider,model,started_at,completed_at,run_json,updated_at)
  values (p_tenant_id,v_project_id,v_id,p_run->>'task',p_run->>'status',p_run#>>'{config,provider}',p_run#>>'{config,model}',v_started_at,
    nullif(coalesce(p_run->>'endedAt', p_run->>'completedAt'),'')::timestamptz,p_run,now())
  on conflict (tenant_id,id) do update set project_id=excluded.project_id,task=excluded.task,status=excluded.status,provider=excluded.provider,
    model=excluded.model,completed_at=excluded.completed_at,run_json=excluded.run_json,updated_at=now();
end;
$$;

create or replace function public.persist_agent_memory(p_tenant_id uuid, p_memory jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_id text := p_memory->>'id';
  v_project_id text := p_memory->>'projectId';
  v_source_run_id text := nullif(p_memory->>'sourceRunId','');
  v_created_at timestamptz := (p_memory->>'createdAt')::timestamptz;
  v_updated_at timestamptz := coalesce(nullif(p_memory->>'updatedAt','')::timestamptz, v_created_at);
  v_expires_at timestamptz := nullif(p_memory->>'expiresAt','')::timestamptz;
  v_existing jsonb;
begin
  if p_tenant_id is null or v_id is null or v_id !~ '^mem-[a-zA-Z0-9-]+$' or v_project_id is null or v_project_id !~ '^project-[a-zA-Z0-9-]+$' then
    raise exception 'invalid tenant, project, or memory id';
  end if;
  if not exists (select 1 from public.agent_projects where tenant_id=p_tenant_id and id=v_project_id) then raise exception 'project not registered'; end if;
  if v_source_run_id is not null then
    select memory_json into v_existing from public.agent_memories where tenant_id=p_tenant_id and project_id=v_project_id and source_run_id=v_source_run_id;
    if v_existing is not null then return v_existing; end if;
  end if;
  insert into public.agent_memories (tenant_id,project_id,id,scope,kind,content,tags,importance,source_run_id,memory_json,created_at,updated_at,expires_at)
  values (p_tenant_id,v_project_id,v_id,p_memory->>'scope',p_memory->>'kind',p_memory->>'content',coalesce(p_memory->'tags','[]'::jsonb),
    coalesce((p_memory->>'importance')::double precision,0.5),v_source_run_id,p_memory,v_created_at,v_updated_at,v_expires_at)
  on conflict (tenant_id,id) do update set project_id=excluded.project_id,scope=excluded.scope,kind=excluded.kind,content=excluded.content,tags=excluded.tags,
    importance=excluded.importance,source_run_id=excluded.source_run_id,memory_json=excluded.memory_json,updated_at=now(),expires_at=excluded.expires_at
  returning memory_json into v_existing;
  return v_existing;
end;
$$;
