create table if not exists public.agent_rate_limit_buckets (
  tenant_id uuid not null references public.agent_tenants(id) on delete cascade,
  key_sha256 text not null check (key_sha256 ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key_sha256, window_started_at)
);

create index if not exists agent_rate_limit_buckets_expiry_idx on public.agent_rate_limit_buckets(window_started_at);
alter table public.agent_rate_limit_buckets enable row level security;
revoke all on public.agent_rate_limit_buckets from anon, authenticated;

create or replace function public.consume_agent_rate_limit(
  p_tenant_id uuid, p_key_sha256 text, p_limit integer, p_window_seconds integer default 60
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window timestamptz;
  v_count integer;
begin
  if p_key_sha256 !~ '^[a-f0-9]{64}$' or p_limit < 1 or p_limit > 10000 or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception 'Invalid rate-limit parameters';
  end if;
  v_window := to_timestamp(floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds);
  insert into public.agent_rate_limit_buckets(tenant_id,key_sha256,window_started_at,request_count,updated_at)
  values (p_tenant_id,p_key_sha256,v_window,1,v_now)
  on conflict (tenant_id,key_sha256,window_started_at) do update
    set request_count=public.agent_rate_limit_buckets.request_count+1,updated_at=v_now
  returning request_count into v_count;
  if random() < 0.01 then
    delete from public.agent_rate_limit_buckets where window_started_at < v_now - interval '1 day';
  end if;
  return jsonb_build_object('allowed',v_count <= p_limit,'remaining',greatest(p_limit-v_count,0),'resetAt',extract(epoch from v_window + make_interval(secs => p_window_seconds))*1000,'backend','supabase-postgres');
end $$;

revoke all on function public.consume_agent_rate_limit(uuid,text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_agent_rate_limit(uuid,text,integer,integer) to service_role;

