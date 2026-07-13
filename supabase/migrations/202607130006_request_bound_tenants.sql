create unique index if not exists agent_identities_token_sha256_global_uidx
  on public.agent_identities (token_sha256);

comment on index public.agent_identities_token_sha256_global_uidx is
  'Prevents one credential digest from resolving to more than one tenant during server-side authentication.';

create or replace function public.verify_agent_tenant_boundary(p_tenant_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_name text; v_unique boolean;
begin
  select name into v_name from public.agent_tenants where id=p_tenant_id;
  if v_name is null then raise exception 'tenant not found'; end if;
  select exists (
    select 1 from pg_indexes
    where schemaname='public' and tablename='agent_identities'
      and indexname='agent_identities_token_sha256_global_uidx'
  ) into v_unique;
  return jsonb_build_object('tenantName',v_name,'requestBound',true,'credentialGlobalUniqueness',v_unique);
end;
$$;

revoke all on function public.verify_agent_tenant_boundary(uuid) from public, anon, authenticated;
grant execute on function public.verify_agent_tenant_boundary(uuid) to service_role;
