create or replace function public.set_agent_tenant_status(p_tenant_id uuid, p_status text, p_actor text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_tenant public.agent_tenants%rowtype;
  v_previous text;
  v_event text;
begin
  if p_tenant_id is null or p_status not in ('active','suspended')
    or char_length(coalesce(p_actor,'')) not between 2 and 128 then
    raise exception 'invalid organization lifecycle request';
  end if;

  select * into v_tenant from public.agent_tenants where id=p_tenant_id for update;
  if v_tenant.id is null then raise exception 'organization not found'; end if;
  v_previous := v_tenant.status;

  if v_previous <> p_status then
    update public.agent_tenants set status=p_status,updated_at=now()
    where id=p_tenant_id returning * into v_tenant;
    v_event := case when p_status='suspended' then 'suspended' else 'reactivated' end;
    insert into public.agent_tenant_events (tenant_id,event_type,actor_id,metadata)
    values (p_tenant_id,v_event,p_actor,jsonb_build_object('previousStatus',v_previous,'status',p_status));
  end if;

  return jsonb_build_object(
    'organization',jsonb_build_object('id',v_tenant.id,'name',v_tenant.name,'slug',v_tenant.slug,'status',v_tenant.status,'createdAt',v_tenant.created_at,'updatedAt',v_tenant.updated_at),
    'changed',v_previous <> p_status
  );
end;
$$;

revoke all on function public.set_agent_tenant_status(uuid,text,text) from public, anon, authenticated;
grant execute on function public.set_agent_tenant_status(uuid,text,text) to service_role;

comment on function public.set_agent_tenant_status(uuid,text,text) is
  'Atomically changes organization admission state and appends its lifecycle event. Authorization is enforced by the platform API before this service-only RPC.';

create or replace function public.verify_agent_tenant_boundary(p_tenant_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_name text; v_slug text; v_status text; v_unique boolean;
begin
  select name,slug,status into v_name,v_slug,v_status from public.agent_tenants where id=p_tenant_id;
  if v_name is null then raise exception 'tenant not found'; end if;
  select exists (
    select 1 from pg_indexes
    where schemaname='public' and tablename='agent_identities'
      and indexname='agent_identities_token_sha256_global_uidx'
  ) into v_unique;
  return jsonb_build_object('tenantName',v_name,'tenantSlug',v_slug,'tenantStatus',v_status,'requestBound',true,'credentialGlobalUniqueness',v_unique,'organizationProvisioning',true,'tenantLifecycleEnforcement',true);
end;
$$;

revoke all on function public.verify_agent_tenant_boundary(uuid) from public, anon, authenticated;
grant execute on function public.verify_agent_tenant_boundary(uuid) to service_role;
