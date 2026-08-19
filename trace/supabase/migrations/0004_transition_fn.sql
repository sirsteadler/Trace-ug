-- TRACE — Phase 2: the state machine. SRS §4.2, §4.3, §6.1.1.
--
-- ARCHITECTURE (deviates from §6.1, pending ratification as v1.2): the
-- transition is a SECURITY DEFINER Postgres function over RPC, not an Edge
-- Function. FR-STM-005 requires the status update and the audit insert to be
-- atomic; in Postgres that is free. SECURITY DEFINER also delivers CON-002
-- structurally — no client role holds a grant on deliveries.status.
--
-- NFR-SEC-016: explicit search_path on every function; no dynamic SQL anywhere.

-- §4.2 transition table, as data. Mirrors src/lib/contract/status.ts.
create table transition_rules (
  id                    text not null,
  from_status           delivery_status,
  to_status             delivery_status not null,
  actors                actor_type[] not null,
  requires_position     boolean not null default false,
  requires_geofence     boolean not null default false,
  requires_confirmation boolean not null default false,
  requires_reason       boolean not null default false,
  primary key (from_status, to_status)
);

insert into transition_rules
  (id, from_status, to_status, actors, requires_position, requires_geofence, requires_confirmation, requires_reason)
values
  ('T-02','CREATED','ASSIGNED',   '{admin}',           false,false,false,false),
  ('T-03','ASSIGNED','ACCEPTED',  '{rider}',           false,false,false,false),
  ('T-04','ASSIGNED','CREATED',   '{rider}',           false,false,false,true ),
  ('T-05','ASSIGNED','ASSIGNED',  '{admin}',           false,false,false,false),
  ('T-06','ACCEPTED','AT_PICKUP', '{rider}',           true, false,false,false),
  ('T-07','AT_PICKUP','PICKED_UP','{rider}',           true, false,false,false),
  ('T-08','PICKED_UP','IN_TRANSIT','{rider,system}',   true, false,false,false),
  ('T-09','IN_TRANSIT','ARRIVED', '{rider}',           true, false,false,false),
  -- FR-CNF-001: the recipient's tap is what closes a Tier 1 delivery, so the
  -- recipient is an actor here, not only at T-11.
  ('T-10','ARRIVED','DELIVERED',  '{rider,recipient}', true, true, true, false),
  -- FR-CNF-005: a Tier 3 close lands on DELIVERED, and the recipient's later
  -- reply to the asynchronous SMS is what carries it to CONFIRMED.
  ('T-11','DELIVERED','CONFIRMED','{recipient,system}',false,false,false,false),
  ('T-12','ASSIGNED','FAILED',    '{rider,admin}',     false,false,false,true ),
  ('T-12','ACCEPTED','FAILED',    '{rider,admin}',     false,false,false,true ),
  ('T-12','AT_PICKUP','FAILED',   '{rider,admin}',     false,false,false,true ),
  ('T-12','PICKED_UP','FAILED',   '{rider,admin}',     false,false,false,true ),
  ('T-12','IN_TRANSIT','FAILED',  '{rider,admin}',     false,false,false,true ),
  ('T-12','ARRIVED','FAILED',     '{rider,admin}',     false,false,false,true ),
  ('T-13','PICKED_UP','RETURNED', '{rider,admin}',     false,false,false,true ),
  ('T-13','IN_TRANSIT','RETURNED','{rider,admin}',     false,false,false,true ),
  ('T-13','ARRIVED','RETURNED',   '{rider,admin}',     false,false,false,true );

alter table transition_rules enable row level security;
create policy transition_rules_read on transition_rules for select using (true);

-- Haversine. Written out rather than taking a dependency on earthdistance or
-- postgis, both of which are avoidable weight on a free-tier pilot.
create or replace function distance_m(
  lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric
) returns numeric
language sql immutable set search_path = public as $$
  select 2 * 6371008.8 * asin(least(1, sqrt(
      sin(radians(lat2 - lat1) / 2) ^ 2
    + sin(radians(lng2 - lng1) / 2) ^ 2 * cos(radians(lat1)) * cos(radians(lat2))
  )))::numeric;
$$;

create or replace function raise_trace_error(code text, detail jsonb default null)
returns void language plpgsql set search_path = public as $$
begin
  raise exception '%', code using errcode = 'raise_exception', detail = coalesce(detail::text, '');
end;
$$;

-- The single state write path. -------------------------------------------------
create or replace function delivery_transition(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_delivery      deliveries%rowtype;
  v_rule          transition_rules%rowtype;
  v_actor         actor_type;
  v_role          user_role;
  v_to            delivery_status;
  v_key           text;
  v_existing      delivery_events%rowtype;
  v_lat           numeric;
  v_lng           numeric;
  v_accuracy      numeric;
  v_distance      numeric;
  v_method        text;
  v_anomalies     text[] := '{}';
  v_event_id      bigint;
  v_prev          record;
  v_speed_kmh     numeric;
  v_final_status  delivery_status;
  v_tier          smallint;
  v_org           uuid;
  v_track_claim   uuid;
  v_device_time   timestamptz;
  v_prev_device_time timestamptz;
begin
  v_key := payload->>'idempotency_key';
  v_to  := (payload->>'to_status')::delivery_status;

  -- GUARD 1: actor authorisation. First, so an unauthorised caller learns
  -- nothing about delivery state (FR-STM-008).
  --
  -- Two identity sources. Staff and riders arrive as Supabase users. Recipients
  -- have no account at all and arrive holding a scoped tracking JWT whose
  -- tracking_delivery_id claim names the one delivery they may act on.
  v_track_claim := nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'tracking_delivery_id', ''
  )::uuid;

  if auth.uid() is not null then
    select role, org_id into v_role, v_org
      from profiles where id = auth.uid() and is_active;
    if v_role is null then
      perform raise_trace_error('UNAUTHENTICATED');
    end if;

    -- Mapped explicitly. `case when rider then rider else admin` collapses every
    -- other role — including `sender`, which exists in user_role — into full
    -- admin transition rights over every delivery in the database.
    v_actor := case v_role
                 when 'rider'       then 'rider'::actor_type
                 when 'sub_admin'   then 'admin'::actor_type
                 when 'super_admin' then 'admin'::actor_type
                 else null
               end;
    if v_actor is null then
      perform raise_trace_error('FORBIDDEN_ACTOR');
    end if;
  elsif v_track_claim is not null then
    v_actor := 'recipient'::actor_type;
  else
    perform raise_trace_error('UNAUTHENTICATED');
  end if;

  -- FOR UPDATE. Without the lock two concurrent calls both read ARRIVED, both
  -- pass legality and both write. The idempotency index stops a duplicate of the
  -- SAME action; it does nothing about two different ones racing.
  select * into v_delivery from deliveries
    where id = (payload->>'delivery_id')::uuid
    for update;
  if not found then
    perform raise_trace_error('FORBIDDEN_ACTOR');
  end if;

  if v_actor = 'recipient' then
    -- The claim, not the payload, decides which delivery a recipient may touch.
    if v_delivery.id is distinct from v_track_claim then
      perform raise_trace_error('FORBIDDEN_ACTOR');
    end if;
  else
    if v_delivery.org_id is distinct from v_org then
      perform raise_trace_error('FORBIDDEN_ACTOR');
    end if;
  end if;

  if v_actor = 'rider' and v_delivery.assigned_rider_id is distinct from auth.uid() then
    perform raise_trace_error('FORBIDDEN_ACTOR');
  end if;
  if v_actor = 'rider' and not has_open_shift() then
    perform raise_trace_error('SHIFT_NOT_OPEN');
  end if;

  -- GUARD 2: idempotency. Deliberately evaluated BEFORE legality: a replayed
  -- action has already moved the delivery on, so a legality check first would
  -- reject the very replay that FR-STM-004 exists to make safe. This corrects
  -- the guard order stated in FR-STM-008.
  if v_key is not null then
    select * into v_existing from delivery_events
      where meta->>'idempotency_key' = v_key;
    if found then
      return jsonb_build_object(
        'delivery_id', v_delivery.id,
        'status',      v_delivery.status,
        'event_id',    v_existing.id,
        'server_time', v_existing.server_time,
        'health',      v_delivery.health,
        'anomalies',   coalesce(v_existing.meta->'anomalies', '[]'::jsonb)
      );
    end if;
  end if;

  -- GUARD 3: transition legality.
  select * into v_rule from transition_rules
    where from_status = v_delivery.status and to_status = v_to;
  if not found then
    perform raise_trace_error('ILLEGAL_TRANSITION',
      jsonb_build_object('from', v_delivery.status, 'requested', v_to));
  end if;
  if not (v_actor = any(v_rule.actors)) then
    perform raise_trace_error('FORBIDDEN_ACTOR');
  end if;
  if v_rule.requires_reason and coalesce(payload->>'reason','') = '' then
    perform raise_trace_error('INVALID_PAYLOAD', '{"field":"reason"}'::jsonb);
  end if;

  v_lat      := nullif(payload#>>'{position,lat}','')::numeric;
  v_lng      := nullif(payload#>>'{position,lng}','')::numeric;
  v_accuracy := nullif(payload#>>'{position,accuracy_m}','')::numeric;

  -- A recipient's own position is irrelevant and untrusted: the geofence asks
  -- where the RIDER is, and the recipient is merely the one asserting receipt.
  -- Their tap therefore borrows the rider's last live fix, which must be recent
  -- enough to still describe the handover rather than an earlier part of the trip.
  if v_actor = 'recipient' then
    select lat, lng, accuracy_m into v_lat, v_lng, v_accuracy
      from rider_positions
     where rider_id = v_delivery.assigned_rider_id
       and updated_at > now() - interval '10 minutes';
    if not found then
      perform raise_trace_error('POSITION_REQUIRED',
        '{"reason":"no recent rider position to validate against"}'::jsonb);
    end if;
  end if;

  if v_rule.requires_position and (v_lat is null or v_lng is null) then
    perform raise_trace_error('POSITION_REQUIRED');
  end if;
  if v_lat is not null and (v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180) then
    perform raise_trace_error('INVALID_COORDINATE');
  end if;

  -- GUARD 4: geofence. FR-STM-015 — validated on the position captured on the
  -- device at the time of the action, which is what the payload carries, not
  -- on where the rider happens to be at synchronisation time.
  if v_rule.requires_geofence then
    if v_delivery.destination_lat is null or v_delivery.destination_lng is null then
      perform raise_trace_error('DESTINATION_NOT_GEOCODED');
    end if;
    v_distance := distance_m(v_lat, v_lng, v_delivery.destination_lat, v_delivery.destination_lng);
    if v_distance > v_delivery.geofence_radius_m then
      perform raise_trace_error('OUTSIDE_GEOFENCE', jsonb_build_object(
        'distance_m', round(v_distance), 'allowed_m', v_delivery.geofence_radius_m));
    end if;
  end if;

  -- GUARD 5: confirmation. SRS §5.4, the three-tier ladder.
  --
  --   Tier 1  recipient_tap        the recipient's own affirmation
  --   Tier 2  pin_entry            a code only the recipient received
  --   Tier 3  signature/photograph the rider's account of the handover
  --
  -- FR-CNF-009: the ladder may be descended but never climbed. Tier 1 is the
  -- recipient asserting receipt, so only a recipient may claim it — otherwise a
  -- rider could manufacture the strongest proof in the system unaided.
  if v_rule.requires_confirmation then
    v_method := payload#>>'{confirmation,method}';
    if v_method is null then
      perform raise_trace_error('CONFIRMATION_REQUIRED');
    end if;

    case v_method
      when 'recipient_tap' then
        if v_actor <> 'recipient' then
          perform raise_trace_error('FORBIDDEN_ACTOR',
            '{"reason":"tier 1 is the recipient''s own act (FR-CNF-009)"}'::jsonb);
        end if;
        v_tier := 1;
      when 'pin_entry' then
        perform verify_confirmation_pin(v_delivery.id, payload#>>'{confirmation,pin}');
        v_tier := 2;
      when 'signature', 'photograph' then
        v_tier := 3;
      else
        perform raise_trace_error('INVALID_PAYLOAD', '{"field":"confirmation.method"}'::jsonb);
    end case;
  end if;

  -- Anomaly annotation. Accept-and-flag: a false rejection strands a rider.
  if coalesce((payload#>>'{position,is_mock}')::boolean, false) then
    v_anomalies := v_anomalies || 'mock_provider';
  end if;
  if v_accuracy is not null and v_accuracy > 200 then
    v_anomalies := v_anomalies || 'unreliable_position';
  end if;

  -- FR-STM-014: a device clock ahead of the server, or running backwards within
  -- a chain, is flagged and accepted. Device clocks are wrong often; that is a
  -- data-quality signal, not grounds to discard a rider's work.
  v_device_time := nullif(payload->>'device_time','')::timestamptz;
  if v_device_time is not null then
    if v_device_time > now() + interval '2 minutes' then
      v_anomalies := v_anomalies || 'clock_skew';
    else
      select max(device_time) into v_prev_device_time
        from delivery_events where delivery_id = v_delivery.id;
      if v_prev_device_time is not null and v_device_time < v_prev_device_time then
        v_anomalies := v_anomalies || 'clock_skew';
      end if;
    end if;
  end if;

  select lat, lng, server_time into v_prev from delivery_events
    where delivery_id = v_delivery.id and lat is not null
    order by id desc limit 1;
  if found and v_lat is not null then
    v_speed_kmh := case
      when extract(epoch from (now() - v_prev.server_time)) > 0
      then distance_m(v_prev.lat, v_prev.lng, v_lat, v_lng)
           / extract(epoch from (now() - v_prev.server_time)) * 3.6
      else 0 end;
    if v_speed_kmh > 200 then
      v_anomalies := v_anomalies || 'impossible_speed';
    end if;
  end if;

  -- FR-STM-007 / FR-CNF-010: where the position cannot be trusted, the proof of
  -- WHO must carry the weight the proof of WHERE cannot. Tier 3 is the rider's
  -- own account, so it is exactly the tier that must not be available here.
  if v_rule.requires_geofence
     and 'unreliable_position' = any(v_anomalies)
     and v_tier = 3 then
    perform raise_trace_error('CONFIRMATION_REQUIRED',
      '{"reason":"unreliable_position requires tier 1 or tier 2"}'::jsonb);
  end if;

  -- Commit. FR-STM-005: one atomic transaction, or nothing.
  v_final_status := v_to;
  -- Tiers 1 and 2 both carry the recipient's own affirmation — a tap they made,
  -- or a code only they received — so either runs straight through to CONFIRMED
  -- (FR-CNF-001). Tier 3 is the rider's account of the handover: it stops at
  -- DELIVERED and waits for the asynchronous SMS reply (FR-CNF-005). Dispatch
  -- sees those as "delivered, unconfirmed" rather than having them upgraded.
  if v_to = 'DELIVERED' and v_tier in (1, 2) then
    v_final_status := 'CONFIRMED';
  end if;

  perform set_config('trace.transition_ok', '1', true);

  insert into delivery_events (
    delivery_id, from_status, to_status, actor_type, actor_id,
    lat, lng, accuracy_m, device_time, was_offline, meta
  ) values (
    v_delivery.id, v_delivery.status, v_final_status, v_actor, auth.uid(),
    v_lat, v_lng, v_accuracy,
    nullif(payload->>'device_time','')::timestamptz,
    coalesce((payload->>'was_offline')::boolean, false),
    jsonb_strip_nulls(jsonb_build_object(
      'idempotency_key', v_key,
      'rule',            v_rule.id,
      'reason',          payload->>'reason',
      'note',            payload->>'note',
      'confirmation_method', v_method,
      'confirmation_tier',   v_tier,
      'anomalies',       to_jsonb(v_anomalies)
    ))
  ) returning id into v_event_id;

  update deliveries set
    status            = v_final_status,
    confirmation_tier = coalesce(v_tier, confirmation_tier),
    completed_at      = case when v_final_status in ('CONFIRMED','FAILED','RETURNED')
                             then now() else completed_at end,
    assigned_rider_id = case when v_final_status = 'CREATED' then null else assigned_rider_id end
  where id = v_delivery.id;

  -- Side effect declared in SERVER_SIDE_EFFECTS: arriving dispatches the OTP.
  if v_final_status = 'ARRIVED' then
    perform issue_confirmation_pin(v_delivery.id);
  end if;

  return jsonb_build_object(
    'delivery_id', v_delivery.id,
    'status',      v_final_status,
    'event_id',    v_event_id,
    'server_time', now(),
    'health',      v_delivery.health,
    'anomalies',   to_jsonb(v_anomalies)
  );
end;
$$;

revoke all on function delivery_transition(jsonb) from public;
grant execute on function delivery_transition(jsonb) to authenticated;

-- Offline batch replay. FR-STM-011: all-or-nothing. -----------------------------
create or replace function sync_queue(batch_id uuid, actions jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_action    jsonb;
  v_committed text[] := '{}';
  v_index     int := 0;
  v_failed    jsonb;
  v_state     delivery_status;
begin
  -- plpgsql exceptions roll the whole function back, so validating as we go IS
  -- validating the chain before committing any of it: a failure at index 3
  -- discards the commits from 0..2. FR-STM-011.
  for v_action in select * from jsonb_array_elements(actions)
  loop
    v_failed := v_action;
    perform delivery_transition(v_action || jsonb_build_object('was_offline', true));
    v_committed := v_committed || (v_action->>'idempotency_key');
    v_index := v_index + 1;
  end loop;
  return to_jsonb(v_committed);
exception
  when others then
    -- FR-STM-012: return the conflicting server state and enough structure for
    -- the rider to be told, in plain language, which action failed and what
    -- changed underneath them. Flattening this to a message string leaves the
    -- client with nothing to explain and nothing to resolve.
    --
    -- The failed subtransaction is rolled back by the time we get here, so this
    -- read sees committed state rather than anything the loop attempted.
    select status into v_state from deliveries
      where id = (v_failed->>'delivery_id')::uuid;

    raise exception 'CHAIN_CONFLICT'
      using errcode = 'raise_exception',
            detail = jsonb_build_object(
              'batch_id',        batch_id,
              'failed_index',    v_index,
              'failed_key',      v_failed->>'idempotency_key',
              'delivery_id',     v_failed->>'delivery_id',
              'requested',       v_failed->>'to_status',
              'server_status',   v_state,
              'code',            sqlerrm,
              'committed_count', array_length(v_committed, 1)
            )::text;
end;
$$;

revoke all on function sync_queue(uuid, jsonb) from public;
grant execute on function sync_queue(uuid, jsonb) to authenticated;
