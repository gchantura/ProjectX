alter table public.agent_oidc_connections
  add column if not exists encryption_key_id text not null default 'legacy';

alter table public.agent_oidc_connections
  drop constraint if exists agent_oidc_connections_client_secret_ciphertext_check;
alter table public.agent_oidc_connections
  add constraint agent_oidc_connections_client_secret_ciphertext_check check (
    client_secret_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    or client_secret_ciphertext ~ '^v2\.[A-Za-z0-9][A-Za-z0-9_-]{0,31}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
  );
alter table public.agent_oidc_connections
  add constraint agent_oidc_connections_encryption_key_id_check check (
    encryption_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'
    and ((client_secret_ciphertext like 'v1.%' and encryption_key_id='legacy') or split_part(client_secret_ciphertext,'.',2)=encryption_key_id)
  );

alter table public.agent_oidc_connection_events
  drop constraint if exists agent_oidc_connection_events_event_type_check;
alter table public.agent_oidc_connection_events
  add constraint agent_oidc_connection_events_event_type_check check (event_type in ('configured','rotated','disabled','enabled','reencrypted'));

create index if not exists agent_oidc_connections_key_id_idx on public.agent_oidc_connections (encryption_key_id);

create or replace function public.get_agent_oidc_key_rotation_status(p_active_key_id text)
returns jsonb language sql security invoker set search_path=public as $$
  with key_counts as (
    select encryption_key_id, count(*)::integer as records
    from public.agent_oidc_connections
    group by encryption_key_id
  )
  select jsonb_build_object(
    'activeKeyId',p_active_key_id,
    'total',coalesce(sum(records),0),
    'pending',coalesce(sum(records) filter (where encryption_key_id<>p_active_key_id),0),
    'byKey',coalesce(jsonb_object_agg(encryption_key_id,records),'{}'::jsonb)
  ) from key_counts
  where p_active_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$';
$$;

revoke all on function public.get_agent_oidc_key_rotation_status(text) from public, anon, authenticated;
grant execute on function public.get_agent_oidc_key_rotation_status(text) to service_role;

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
    or coalesce(p_connection->>'clientSecretCiphertext','') !~ '^v2\.[A-Za-z0-9][A-Za-z0-9_-]{0,31}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    or coalesce(p_connection->>'encryptionKeyId','') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'
    or split_part(p_connection->>'clientSecretCiphertext','.',2) <> p_connection->>'encryptionKeyId'
    or char_length(coalesce(p_connection->>'scopes','')) not between 1 and 500
    or jsonb_typeof(coalesce(p_connection->'allowedEndpointOrigins','[]'::jsonb)) <> 'array'
    or char_length(coalesce(p_actor,'')) not between 2 and 128 then
    raise exception 'invalid OIDC connection';
  end if;

  select * into v_existing from public.agent_oidc_connections where tenant_id=p_tenant_id for update;
  v_event := case when v_existing.tenant_id is null then 'configured' else 'rotated' end;

  insert into public.agent_oidc_connections (tenant_id,display_name,issuer,client_id,client_secret_ciphertext,encryption_key_id,scopes,allowed_endpoint_origins,status,revision,updated_by)
  values (p_tenant_id,p_connection->>'displayName',p_connection->>'issuer',p_connection->>'clientId',p_connection->>'clientSecretCiphertext',p_connection->>'encryptionKeyId',p_connection->>'scopes',coalesce(p_connection->'allowedEndpointOrigins','[]'::jsonb),'active',gen_random_uuid(),p_actor)
  on conflict (tenant_id) do update set
    display_name=excluded.display_name,issuer=excluded.issuer,client_id=excluded.client_id,
    client_secret_ciphertext=excluded.client_secret_ciphertext,encryption_key_id=excluded.encryption_key_id,scopes=excluded.scopes,
    allowed_endpoint_origins=excluded.allowed_endpoint_origins,status='active',revision=excluded.revision,
    updated_at=now(),updated_by=p_actor
  returning * into v_stored;

  insert into public.agent_oidc_connection_events (tenant_id,event_type,revision,actor_id,metadata)
  values (p_tenant_id,v_event,v_stored.revision,p_actor,jsonb_build_object('issuer',v_stored.issuer,'clientIdSha256',encode(digest(v_stored.client_id,'sha256'),'hex'),'encryptionKeyId',v_stored.encryption_key_id));

  return jsonb_build_object('tenantId',v_stored.tenant_id,'displayName',v_stored.display_name,'issuer',v_stored.issuer,'clientId',v_stored.client_id,'scopes',v_stored.scopes,'allowedEndpointOrigins',v_stored.allowed_endpoint_origins,'status',v_stored.status,'revision',v_stored.revision,'encryptionKeyId',v_stored.encryption_key_id,'createdAt',v_stored.created_at,'updatedAt',v_stored.updated_at,'secretConfigured',true);
end;
$$;

create or replace function public.set_agent_oidc_connection_status(p_tenant_id uuid, p_status text, p_actor text)
returns jsonb language plpgsql security invoker set search_path=public,extensions as $$
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
  return jsonb_build_object('tenantId',v_stored.tenant_id,'displayName',v_stored.display_name,'issuer',v_stored.issuer,'clientId',v_stored.client_id,'scopes',v_stored.scopes,'allowedEndpointOrigins',v_stored.allowed_endpoint_origins,'status',v_stored.status,'revision',v_stored.revision,'encryptionKeyId',v_stored.encryption_key_id,'createdAt',v_stored.created_at,'updatedAt',v_stored.updated_at,'secretConfigured',true);
end;
$$;

create or replace function public.reencrypt_agent_oidc_connection(p_tenant_id uuid, p_expected_revision uuid, p_ciphertext text, p_encryption_key_id text, p_actor text)
returns jsonb language plpgsql security invoker set search_path=public,extensions as $$
declare
  v_existing public.agent_oidc_connections%rowtype;
  v_stored public.agent_oidc_connections%rowtype;
begin
  if p_tenant_id is null or p_expected_revision is null
    or coalesce(p_ciphertext,'') !~ '^v2\.[A-Za-z0-9][A-Za-z0-9_-]{0,31}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    or coalesce(p_encryption_key_id,'') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'
    or split_part(p_ciphertext,'.',2) <> p_encryption_key_id
    or char_length(coalesce(p_actor,'')) not between 2 and 128 then
    raise exception 'invalid OIDC secret re-encryption';
  end if;

  select * into v_existing from public.agent_oidc_connections where tenant_id=p_tenant_id for update;
  if v_existing.tenant_id is null then raise exception 'OIDC connection not found'; end if;
  if v_existing.revision <> p_expected_revision then
    raise exception using errcode='40001', message='OIDC connection changed during secret rotation';
  end if;

  update public.agent_oidc_connections set client_secret_ciphertext=p_ciphertext,encryption_key_id=p_encryption_key_id,
    revision=gen_random_uuid(),updated_at=now(),updated_by=p_actor
  where tenant_id=p_tenant_id returning * into v_stored;

  insert into public.agent_oidc_connection_events (tenant_id,event_type,revision,actor_id,metadata)
  values (p_tenant_id,'reencrypted',v_stored.revision,p_actor,jsonb_build_object('previousEncryptionKeyId',v_existing.encryption_key_id,'encryptionKeyId',v_stored.encryption_key_id));

  return jsonb_build_object('tenantId',v_stored.tenant_id,'status',v_stored.status,'revision',v_stored.revision,'encryptionKeyId',v_stored.encryption_key_id,'updatedAt',v_stored.updated_at,'secretConfigured',true);
end;
$$;

revoke all on function public.reencrypt_agent_oidc_connection(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.reencrypt_agent_oidc_connection(uuid,uuid,text,text,text) to service_role;

create or replace function public.verify_agent_tenant_boundary(p_tenant_id uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_name text; v_slug text; v_status text; v_unique boolean;
begin
  select name,slug,status into v_name,v_slug,v_status from public.agent_tenants where id=p_tenant_id;
  if v_name is null then raise exception 'tenant not found'; end if;
  select exists (select 1 from pg_indexes where schemaname='public' and tablename='agent_identities' and indexname='agent_identities_token_sha256_global_uidx') into v_unique;
  return jsonb_build_object('tenantName',v_name,'tenantSlug',v_slug,'tenantStatus',v_status,'requestBound',true,'credentialGlobalUniqueness',v_unique,'organizationProvisioning',true,'tenantLifecycleEnforcement',true,'tenantOidcConnections',true,'managedSecretRotation',true);
end;
$$;

revoke all on function public.verify_agent_tenant_boundary(uuid) from public, anon, authenticated;
grant execute on function public.verify_agent_tenant_boundary(uuid) to service_role;
