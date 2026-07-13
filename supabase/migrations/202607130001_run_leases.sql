create unique index if not exists agent_runs_tenant_project_id_idx on public.agent_runs (tenant_id, project_id, id);

create table if not exists public.agent_run_leases (
  tenant_id uuid not null,
  project_id text not null,
  run_id text not null,
  lease_token uuid not null,
  owner_id text not null check (char_length(owner_id) between 8 and 160),
  attempt integer not null default 1 check (attempt > 0),
  acquired_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (tenant_id, run_id),
  foreign key (tenant_id, project_id, run_id) references public.agent_runs(tenant_id, project_id, id) on delete cascade
);

create index if not exists agent_run_leases_expiry_idx on public.agent_run_leases (expires_at);
alter table public.agent_run_leases enable row level security;
revoke all on public.agent_run_leases from anon, authenticated;

create or replace function public.claim_agent_run_lease(p_tenant_id uuid, p_project_id text, p_run_id text, p_owner_id text, p_ttl_seconds integer)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_lease public.agent_run_leases%rowtype;
  v_ttl integer := least(greatest(coalesce(p_ttl_seconds, 300), 30), 900);
begin
  if p_tenant_id is null or p_project_id !~ '^project-[a-zA-Z0-9-]+$' or p_run_id !~ '^run-[a-zA-Z0-9-]+$' or char_length(coalesce(p_owner_id,'')) not between 8 and 160 then
    raise exception 'invalid run lease claim';
  end if;
  insert into public.agent_run_leases (tenant_id,project_id,run_id,lease_token,owner_id,attempt,acquired_at,heartbeat_at,expires_at)
  values (p_tenant_id,p_project_id,p_run_id,gen_random_uuid(),p_owner_id,1,now(),now(),now() + make_interval(secs => v_ttl))
  on conflict (tenant_id,run_id) do update
    set project_id=excluded.project_id,lease_token=gen_random_uuid(),owner_id=excluded.owner_id,
        attempt=public.agent_run_leases.attempt + 1,acquired_at=now(),heartbeat_at=now(),expires_at=now() + make_interval(secs => v_ttl)
    where public.agent_run_leases.expires_at <= now()
  returning * into v_lease;
  if v_lease.run_id is null then
    select * into v_lease from public.agent_run_leases where tenant_id=p_tenant_id and run_id=p_run_id;
    return jsonb_build_object('acquired',false,'runId',p_run_id,'ownerId',v_lease.owner_id,'expiresAt',v_lease.expires_at,'attempt',v_lease.attempt);
  end if;
  return jsonb_build_object('acquired',true,'runId',v_lease.run_id,'projectId',v_lease.project_id,'leaseToken',v_lease.lease_token,
    'ownerId',v_lease.owner_id,'expiresAt',v_lease.expires_at,'attempt',v_lease.attempt);
end;
$$;

create or replace function public.heartbeat_agent_run_lease(p_tenant_id uuid, p_run_id text, p_lease_token uuid, p_ttl_seconds integer)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_lease public.agent_run_leases%rowtype;
  v_ttl integer := least(greatest(coalesce(p_ttl_seconds, 300), 30), 900);
begin
  update public.agent_run_leases set heartbeat_at=now(),expires_at=now() + make_interval(secs => v_ttl)
  where tenant_id=p_tenant_id and run_id=p_run_id and lease_token=p_lease_token and expires_at > now()
  returning * into v_lease;
  if v_lease.run_id is null then return jsonb_build_object('renewed',false,'runId',p_run_id); end if;
  return jsonb_build_object('renewed',true,'runId',v_lease.run_id,'expiresAt',v_lease.expires_at,'attempt',v_lease.attempt);
end;
$$;

create or replace function public.release_agent_run_lease(p_tenant_id uuid, p_run_id text, p_lease_token uuid)
returns boolean language plpgsql security invoker set search_path = public as $$
declare v_deleted integer;
begin
  delete from public.agent_run_leases where tenant_id=p_tenant_id and run_id=p_run_id and lease_token=p_lease_token;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

revoke all on function public.claim_agent_run_lease(uuid,text,text,text,integer) from public, anon, authenticated;
revoke all on function public.heartbeat_agent_run_lease(uuid,text,uuid,integer) from public, anon, authenticated;
revoke all on function public.release_agent_run_lease(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.claim_agent_run_lease(uuid,text,text,text,integer) to service_role;
grant execute on function public.heartbeat_agent_run_lease(uuid,text,uuid,integer) to service_role;
grant execute on function public.release_agent_run_lease(uuid,text,uuid) to service_role;
