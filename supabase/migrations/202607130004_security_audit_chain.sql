create extension if not exists pgcrypto;

create table if not exists public.agent_audit_events (
  tenant_id uuid not null references public.agent_tenants(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  sequence bigint not null check (sequence > 0),
  occurred_at timestamptz not null,
  actor_id text not null check (char_length(actor_id) between 1 and 200),
  actor_role text not null check (actor_role in ('viewer','operator','admin','system')),
  action text not null check (char_length(action) between 1 and 200),
  resource_type text,
  resource_id text,
  outcome text not null check (outcome in ('succeeded','failed')),
  request_id text not null check (char_length(request_id) between 1 and 128),
  trace_id text not null check (trace_id ~ '^[a-f0-9]{32}$'),
  metadata jsonb not null default '{}'::jsonb,
  previous_hash text,
  event_hash text not null check (event_hash ~ '^[a-f0-9]{64}$'),
  primary key (tenant_id, id),
  unique (tenant_id, sequence),
  unique (tenant_id, request_id, action),
  check (previous_hash is null or previous_hash ~ '^[a-f0-9]{64}$'),
  check (jsonb_typeof(metadata) = 'object')
);

create index if not exists agent_audit_events_tenant_time_idx on public.agent_audit_events(tenant_id, occurred_at desc);
alter table public.agent_audit_events enable row level security;
revoke all on public.agent_audit_events from anon, authenticated;

create or replace function public.append_agent_audit_event(p_tenant_id uuid, p_event jsonb)
returns public.agent_audit_events
language plpgsql security definer set search_path=public,extensions as $$
declare
  v_existing public.agent_audit_events;
  v_row public.agent_audit_events;
  v_sequence bigint;
  v_previous_hash text;
  v_occurred_at timestamptz := coalesce((p_event->>'occurredAt')::timestamptz, clock_timestamp());
  v_metadata jsonb := coalesce(p_event->'metadata', '{}'::jsonb);
  v_canonical text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 41074));
  select * into v_existing from public.agent_audit_events
    where tenant_id=p_tenant_id and request_id=p_event->>'requestId' and action=p_event->>'action';
  if found then return v_existing; end if;

  if jsonb_typeof(v_metadata) <> 'object' or octet_length(v_metadata::text) > 8192 then
    raise exception 'Audit metadata must be an object no larger than 8 KiB';
  end if;
  select sequence,event_hash into v_sequence,v_previous_hash from public.agent_audit_events
    where tenant_id=p_tenant_id order by sequence desc limit 1;
  v_sequence := coalesce(v_sequence,0)+1;
  v_canonical := concat_ws('|',p_tenant_id::text,v_sequence::text,v_occurred_at::text,p_event->>'actorId',p_event->>'actorRole',p_event->>'action',coalesce(p_event->>'resourceType',''),coalesce(p_event->>'resourceId',''),p_event->>'outcome',p_event->>'requestId',p_event->>'traceId',v_metadata::text,coalesce(v_previous_hash,''));
  insert into public.agent_audit_events(tenant_id,sequence,occurred_at,actor_id,actor_role,action,resource_type,resource_id,outcome,request_id,trace_id,metadata,previous_hash,event_hash)
  values (p_tenant_id,v_sequence,v_occurred_at,p_event->>'actorId',p_event->>'actorRole',p_event->>'action',nullif(p_event->>'resourceType',''),nullif(p_event->>'resourceId',''),p_event->>'outcome',p_event->>'requestId',p_event->>'traceId',v_metadata,v_previous_hash,encode(digest(v_canonical,'sha256'),'hex')) returning * into v_row;
  return v_row;
end $$;

create or replace function public.verify_agent_audit_chain(p_tenant_id uuid)
returns jsonb language sql security definer set search_path=public,extensions as $$
  with ordered as (
    select *, lag(event_hash) over(order by sequence) as expected_previous
    from public.agent_audit_events where tenant_id=p_tenant_id
  ), checked as (
    select *, encode(digest(concat_ws('|',tenant_id::text,sequence::text,occurred_at::text,actor_id,actor_role,action,coalesce(resource_type,''),coalesce(resource_id,''),outcome,request_id,trace_id,metadata::text,coalesce(previous_hash,'')),'sha256'),'hex') as expected_hash
    from ordered
  ) select jsonb_build_object(
    'valid', not exists(select 1 from checked where previous_hash is distinct from expected_previous or event_hash <> expected_hash),
    'eventCount', count(*), 'headHash', (array_agg(event_hash order by sequence desc))[1],
    'firstInvalidSequence', min(sequence) filter(where previous_hash is distinct from expected_previous or event_hash <> expected_hash)
  ) from checked
$$;

revoke all on function public.append_agent_audit_event(uuid,jsonb) from public, anon, authenticated;
revoke all on function public.verify_agent_audit_chain(uuid) from public, anon, authenticated;
grant execute on function public.append_agent_audit_event(uuid,jsonb) to service_role;
grant execute on function public.verify_agent_audit_chain(uuid) to service_role;

