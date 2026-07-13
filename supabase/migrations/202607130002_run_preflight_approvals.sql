alter table public.agent_runs drop constraint if exists agent_runs_status_check;
alter table public.agent_runs add constraint agent_runs_status_check
  check (status in ('awaiting_approval','running','completed','verified','needs_attention','stopped'));

create table if not exists public.agent_run_approvals (
  tenant_id uuid not null,
  project_id text not null,
  id uuid not null default gen_random_uuid(),
  run_id text not null,
  plan_sha256 text not null check (plan_sha256 ~ '^[a-f0-9]{64}$'),
  token_sha256 text not null check (token_sha256 ~ '^[a-f0-9]{64}$'),
  decision text not null default 'pending' check (decision in ('pending','approved','rejected','expired')),
  requested_by text not null,
  decided_by text,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  primary key (tenant_id, id),
  unique (tenant_id, run_id),
  foreign key (tenant_id, project_id, run_id) references public.agent_runs(tenant_id, project_id, id) on delete cascade
);

create index if not exists agent_run_approvals_pending_idx on public.agent_run_approvals (tenant_id, decision, expires_at);
alter table public.agent_run_approvals enable row level security;
revoke all on public.agent_run_approvals from anon, authenticated;

create or replace function public.request_agent_run_approval(p_tenant_id uuid, p_project_id text, p_run_id text, p_plan_sha256 text, p_token_sha256 text, p_actor text, p_expires_at timestamptz)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_approval public.agent_run_approvals%rowtype;
begin
  if p_tenant_id is null or p_project_id !~ '^project-[a-zA-Z0-9-]+$' or p_run_id !~ '^run-[a-zA-Z0-9-]+$'
    or p_plan_sha256 !~ '^[a-f0-9]{64}$' or p_token_sha256 !~ '^[a-f0-9]{64}$' or char_length(coalesce(p_actor,'')) not between 1 and 160
    or p_expires_at <= now() then raise exception 'invalid run approval request'; end if;
  insert into public.agent_run_approvals (tenant_id,project_id,run_id,plan_sha256,token_sha256,decision,requested_by,requested_at,expires_at)
  values (p_tenant_id,p_project_id,p_run_id,p_plan_sha256,p_token_sha256,'pending',p_actor,now(),p_expires_at)
  on conflict (tenant_id,run_id) do update set plan_sha256=excluded.plan_sha256,token_sha256=excluded.token_sha256,
    decision='pending',requested_by=excluded.requested_by,decided_by=null,requested_at=now(),decided_at=null,expires_at=excluded.expires_at
  where public.agent_run_approvals.decision in ('pending','expired')
  returning * into v_approval;
  if v_approval.id is null then raise exception 'run approval is already finalized'; end if;
  return jsonb_build_object('id',v_approval.id,'runId',v_approval.run_id,'planSha256',v_approval.plan_sha256,
    'decision',v_approval.decision,'requestedBy',v_approval.requested_by,'requestedAt',v_approval.requested_at,'expiresAt',v_approval.expires_at);
end;
$$;

create or replace function public.consume_agent_run_approval(p_tenant_id uuid, p_project_id text, p_run_id text, p_plan_sha256 text, p_token_sha256 text, p_actor text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_approval public.agent_run_approvals%rowtype;
begin
  update public.agent_run_approvals set decision='approved',decided_by=p_actor,decided_at=now()
  where tenant_id=p_tenant_id and project_id=p_project_id and run_id=p_run_id and plan_sha256=p_plan_sha256
    and token_sha256=p_token_sha256 and decision='pending' and expires_at > now()
  returning * into v_approval;
  if v_approval.id is null then return jsonb_build_object('approved',false,'runId',p_run_id); end if;
  return jsonb_build_object('approved',true,'id',v_approval.id,'runId',v_approval.run_id,'planSha256',v_approval.plan_sha256,
    'decision',v_approval.decision,'decidedBy',v_approval.decided_by,'decidedAt',v_approval.decided_at);
end;
$$;

create or replace function public.reject_agent_run_approval(p_tenant_id uuid, p_project_id text, p_run_id text, p_actor text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_approval public.agent_run_approvals%rowtype;
begin
  update public.agent_run_approvals set decision='rejected',decided_by=p_actor,decided_at=now()
  where tenant_id=p_tenant_id and project_id=p_project_id and run_id=p_run_id and decision='pending'
  returning * into v_approval;
  if v_approval.id is null then return jsonb_build_object('rejected',false,'runId',p_run_id); end if;
  return jsonb_build_object('rejected',true,'id',v_approval.id,'runId',v_approval.run_id,'planSha256',v_approval.plan_sha256,
    'decision',v_approval.decision,'decidedBy',v_approval.decided_by,'decidedAt',v_approval.decided_at);
end;
$$;

revoke all on function public.request_agent_run_approval(uuid,text,text,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.consume_agent_run_approval(uuid,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.reject_agent_run_approval(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.request_agent_run_approval(uuid,text,text,text,text,text,timestamptz) to service_role;
grant execute on function public.consume_agent_run_approval(uuid,text,text,text,text,text) to service_role;
grant execute on function public.reject_agent_run_approval(uuid,text,text,text) to service_role;
