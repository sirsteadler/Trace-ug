-- TRACE — delivery creation and assignment. SRS §5.1.1.
--
-- No client role holds INSERT on deliveries, and that is deliberate: creation
-- decides the trace_id, the org, the geofence radius and the initial audit row,
-- and none of those may come from a client that could simply choose them.
-- Creation goes through a definer function for the same reason transitions do.

-- Human-readable reference. TRC-YYMMDD-NNNN, restarting nowhere: the sequence
-- is global, so a reference is never reused even across days.
create sequence if not exists delivery_reference_seq start 1;

create or replace function next_trace_id()
returns text
language sql
volatile
set search_path = public
as $$
  select 'TRC-' || to_char(now(), 'YYMMDD') || '-' ||
         lpad(nextval('delivery_reference_seq')::text, 4, '0');
$$;

create or replace function create_delivery(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_org      uuid;
  v_delivery deliveries%rowtype;
  v_lat      numeric;
  v_lng      numeric;
begin
  if not is_admin() then
    perform raise_trace_error('FORBIDDEN_ACTOR');
  end if;
  v_org := current_org_id();

  if coalesce(payload->>'recipient_name', '') = '' then
    perform raise_trace_error('INVALID_PAYLOAD', '{"field":"recipient_name"}'::jsonb);
  end if;
  if coalesce(payload->>'recipient_phone', '') = '' then
    perform raise_trace_error('INVALID_PAYLOAD', '{"field":"recipient_phone"}'::jsonb);
  end if;
  if coalesce(payload->>'destination_address', '') = '' then
    perform raise_trace_error('INVALID_PAYLOAD', '{"field":"destination_address"}'::jsonb);
  end if;

  v_lat := nullif(payload->>'destination_lat', '')::numeric;
  v_lng := nullif(payload->>'destination_lng', '')::numeric;

  -- Geocoding happens server-side before this call, so an ungeocoded delivery
  -- is a deliberate state rather than an accident: it can be created and
  -- assigned, but FR-STM-015 will refuse to let it close until it has a
  -- destination to measure the geofence against.
  if v_lat is not null and (v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180) then
    perform raise_trace_error('INVALID_COORDINATE');
  end if;

  insert into deliveries (
    trace_id, org_id, status, source, recipient_name, recipient_phone,
    pickup_address, destination_address, destination_lat, destination_lng,
    item_description, geofence_radius_m, promised_at, eta_at
  ) values (
    next_trace_id(),
    v_org,
    'CREATED',
    coalesce(payload->>'source', 'manual'),
    payload->>'recipient_name',
    payload->>'recipient_phone',
    coalesce(payload->>'pickup_address', ''),
    payload->>'destination_address',
    v_lat,
    v_lng,
    payload->>'item_description',
    coalesce(nullif(payload->>'geofence_radius_m','')::int, 100),
    nullif(payload->>'promised_at','')::timestamptz,
    nullif(payload->>'eta_at','')::timestamptz
  )
  returning * into v_delivery;

  -- T-01. The audit log starts at creation, not at the first movement: who
  -- entered this delivery is as much a part of the record as who carried it.
  insert into delivery_events (
    delivery_id, from_status, to_status, actor_type, actor_id, meta
  ) values (
    v_delivery.id, null, 'CREATED', 'admin', auth.uid(),
    jsonb_build_object('rule', 'T-01', 'source', v_delivery.source)
  );

  return jsonb_build_object(
    'id',       v_delivery.id,
    'trace_id', v_delivery.trace_id,
    'status',   v_delivery.status
  );
end;
$$;

revoke all on function create_delivery(jsonb) from public, anon;
grant execute on function create_delivery(jsonb) to authenticated;

-- Assignment. -------------------------------------------------------------------
-- A separate function because it is two writes that must agree: the rider on the
-- delivery, and the transition recording who assigned them. Doing this from the
-- client would be an UPDATE and an RPC with no transaction around the pair.
create or replace function assign_delivery(p_delivery uuid, p_rider uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_delivery deliveries%rowtype;
  v_rider    profiles%rowtype;
begin
  if not is_admin() then
    perform raise_trace_error('FORBIDDEN_ACTOR');
  end if;

  select * into v_delivery from deliveries
   where id = p_delivery and org_id = current_org_id()
   for update;
  if not found then
    perform raise_trace_error('FORBIDDEN_ACTOR');
  end if;

  select * into v_rider from profiles
   where id = p_rider and org_id = current_org_id() and role = 'rider' and is_active;
  if not found then
    perform raise_trace_error('INVALID_PAYLOAD', '{"field":"rider"}'::jsonb);
  end if;

  -- Set the rider first: the transition guard reads assigned_rider_id, and
  -- T-05 (reassignment) is legal only once someone is already assigned.
  -- No flag needed — the status guard only fires on a status change, and this
  -- is not one. Setting it here would disarm the guard for the rest of the
  -- transaction, which is exactly the bug 0004 was corrected for.
  update deliveries set assigned_rider_id = p_rider where id = p_delivery;

  return delivery_transition(jsonb_build_object(
    'delivery_id',     p_delivery,
    'to_status',       'ASSIGNED',
    'idempotency_key', gen_random_uuid(),
    'device_time',     now(),
    'note',            'assigned to ' || v_rider.full_name
  ));
end;
$$;

revoke all on function assign_delivery(uuid, uuid) from public, anon;
grant execute on function assign_delivery(uuid, uuid) to authenticated;

grant usage on sequence delivery_reference_seq to authenticated;
