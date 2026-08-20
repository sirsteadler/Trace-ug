-- TRACE — full schema, migrations 0001-0008 concatenated in order.
-- Generated for the Supabase SQL editor. Run once, top to bottom, on a fresh
-- project. The canonical files are in supabase/migrations/ — edit those, not
-- this one, and regenerate.

-- ============================================================
-- migrations/0001_schema.sql
-- ============================================================
-- TRACE — Phase 1: schema. SRS v1.1 §3.2, §3.3.
-- Field names, types and nullability here are the frozen contract (CON-008).

create extension if not exists "pgcrypto";

-- §3.3 enumerated vocabularies -------------------------------------------------
create type delivery_status as enum (
  'CREATED','ASSIGNED','ACCEPTED','AT_PICKUP','PICKED_UP',
  'IN_TRANSIT','ARRIVED','DELIVERED','CONFIRMED','FAILED','RETURNED'
);
create type actor_type          as enum ('rider','admin','recipient','system');
create type delivery_health     as enum ('green','amber','red');
create type user_role           as enum ('rider','sub_admin','super_admin','sender');
create type sync_state          as enum ('pending','in_flight','succeeded','parked');
-- SRS v1.0 FR-CNF-001: recipient_tap is Tier 1 and the primary path. The v1.2
-- withdrawal departed from the SRS, the concept note and the brief at once.
create type confirmation_method as enum ('recipient_tap','pin_entry','signature','photograph');

create table organisations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- Per-organisation operational thresholds, read by deliveries_with_health in
  -- 0007: health_amber_minutes, health_red_minutes. Kept as jsonb rather than
  -- columns because these are tuning knobs a dispatcher changes, not schema.
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  org_id     uuid not null references organisations(id),
  -- FR-AUT-003: server-side claim. Never writable by the user it describes;
  -- the RLS policies in 0003 enforce that.
  role       user_role not null,
  full_name  text not null,
  phone      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create index profiles_org_idx on profiles(org_id);

create table shifts (
  id         uuid primary key default gen_random_uuid(),
  rider_id   uuid not null references profiles(id),
  started_at timestamptz not null default now(),
  ended_at   timestamptz
);
-- A rider has at most one open shift. Enforced structurally, not by policy.
create unique index shifts_one_open_per_rider on shifts(rider_id) where ended_at is null;
create index shifts_rider_idx on shifts(rider_id, started_at desc);

create table deliveries (
  id                  uuid primary key default gen_random_uuid(),
  trace_id            text not null unique,
  org_id              uuid not null references organisations(id),
  status              delivery_status not null default 'CREATED',
  source              text not null default 'manual' check (source in ('manual','sap')),
  sap_document_id     text,
  sender_profile_id   uuid references profiles(id),
  recipient_name      text not null,
  recipient_phone     text not null,
  pickup_address      text not null,
  destination_address text not null,
  pickup_lat          numeric(9,6),
  pickup_lng          numeric(9,6),
  destination_lat     numeric(9,6),
  destination_lng     numeric(9,6),
  geofence_radius_m   integer not null default 100 check (geofence_radius_m between 20 and 5000),
  item_description    text,
  assigned_rider_id   uuid references profiles(id),
  eta_at              timestamptz,
  promised_at         timestamptz,
  health              delivery_health not null default 'green',
  -- FR-CNF-008: the tier is recorded so a weaker proof stays visible as one.
  confirmation_tier   smallint check (confirmation_tier in (1,2,3)),
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);
create index deliveries_org_status_idx  on deliveries(org_id, status);
create index deliveries_rider_idx       on deliveries(assigned_rider_id) where assigned_rider_id is not null;
create unique index deliveries_sap_doc  on deliveries(sap_document_id) where sap_document_id is not null;

-- §3.2.2 the audit log. System of record for what happened. --------------------
create table delivery_events (
  id           bigserial primary key,
  delivery_id  uuid not null references deliveries(id),
  from_status  delivery_status,
  to_status    delivery_status not null,
  actor_type   actor_type not null,
  actor_id     uuid,
  lat          numeric(9,6),
  lng          numeric(9,6),
  accuracy_m   numeric,
  device_time  timestamptz,
  server_time  timestamptz not null default now(),
  was_offline  boolean not null default false,
  meta         jsonb not null default '{}'::jsonb
);
create index delivery_events_delivery_idx on delivery_events(delivery_id, id);
-- FR-STM-004: idempotency lookup must be an index hit, not a scan.
create unique index delivery_events_idempotency
  on delivery_events((meta->>'idempotency_key'))
  where meta->>'idempotency_key' is not null;

create table rider_positions (
  rider_id    uuid primary key references profiles(id) on delete cascade,
  shift_id    uuid not null references shifts(id) on delete cascade,
  lat         numeric(9,6) not null,
  lng         numeric(9,6) not null,
  accuracy_m  numeric,
  device_time timestamptz,
  updated_at  timestamptz not null default now()
);

create table position_history (
  id          bigserial primary key,
  delivery_id uuid not null references deliveries(id) on delete cascade,
  segment     jsonb not null,          -- 60-second batch, NFR-CST-002
  started_at  timestamptz not null,
  ended_at    timestamptz not null
);
create index position_history_delivery_idx on position_history(delivery_id, started_at);

create table confirmation_pins (
  delivery_id   uuid primary key references deliveries(id) on delete cascade,
  pin_hash      text not null,          -- NFR-SEC-004: plaintext never stored
  expires_at    timestamptz not null,
  attempt_count integer not null default 0,
  locked_until  timestamptz,
  last_sent_at  timestamptz not null default now(),
  consumed_at   timestamptz
);

create table proof_artifacts (
  id            uuid primary key default gen_random_uuid(),
  delivery_id   uuid not null references deliveries(id) on delete cascade,
  storage_path  text not null,          -- server-derived, never client filename
  content_hash  text,
  lat           numeric(9,6),
  lng           numeric(9,6),
  captured_at   timestamptz not null,
  created_at    timestamptz not null default now()
);
create index proof_artifacts_delivery_idx on proof_artifacts(delivery_id);

create table tracking_tokens (
  id          uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references deliveries(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);

create table sap_sync_queue (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id),
  direction       text not null check (direction in ('inbound','outbound')),
  payload         jsonb not null,
  state           sync_state not null default 'pending',
  attempt_count   integer not null default 0,
  next_attempt_at timestamptz,
  last_error      text,
  created_at      timestamptz not null default now()
);

-- Deliberately unlinked to any delivery so it survives the 30-day purge and
-- keeps suppressing repeat billing. NFR-CST-004.
create table geocode_cache (
  address_norm text primary key,
  lat          numeric(9,6) not null,
  lng          numeric(9,6) not null,
  cached_at    timestamptz not null default now()
);

-- ============================================================
-- migrations/0002_audit_append_only.sql
-- ============================================================
-- TRACE — the append-only audit log. FR-AUD-003, NFR-SEC-008, CON-003.
--
-- TWO independent mechanisms, because one can be misconfigured:
--   1. grants revoked at the database level
--   2. a trigger that raises regardless of grants
-- A future migration that accidentally re-grants UPDATE still hits the trigger.

create or replace function reject_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'delivery_events is append-only (FR-AUD-003)'
    using errcode = 'check_violation';
end;
$$;

create trigger delivery_events_no_update
  before update on delivery_events
  for each row execute function reject_audit_mutation();

create trigger delivery_events_no_delete
  before delete on delivery_events
  for each row execute function reject_audit_mutation();

-- Mechanism 2: no role, including the application role, may mutate history.
-- service_role is included deliberately: every Edge Function holds that key, so
-- omitting it would leave the most privileged credential in the system with a
-- standing grant on the audit log.
revoke update, delete on delivery_events from public;
revoke update, delete on delivery_events from anon, authenticated, service_role;

-- proof_artifacts is evidence too: it may be inserted and read, never rewritten
-- and never removed. Both mechanisms apply here as well.
create trigger proof_artifacts_no_update
  before update on proof_artifacts
  for each row execute function reject_audit_mutation();

create trigger proof_artifacts_no_delete
  before delete on proof_artifacts
  for each row execute function reject_audit_mutation();

revoke update, delete on proof_artifacts from public;
revoke update, delete on proof_artifacts from anon, authenticated, service_role;

-- ============================================================
-- migrations/0003_rls.sql
-- ============================================================
-- TRACE — Row-Level Security. SRS §3.5, NFR-SEC-002.
--
-- RLS is enabled on every table holding organisation data. A table without an
-- explicit policy denies all access by default, and that default is relied
-- upon deliberately (§3.5).
--
-- NON-NEGOTIABLE (§3.5): no role below holds an UPDATE grant on
-- deliveries.status. Status changes exclusively through delivery_transition().

alter table organisations    enable row level security;
alter table profiles         enable row level security;
alter table shifts           enable row level security;
alter table deliveries       enable row level security;
alter table delivery_events  enable row level security;
alter table rider_positions  enable row level security;
alter table position_history enable row level security;
alter table confirmation_pins enable row level security;
alter table proof_artifacts  enable row level security;
alter table tracking_tokens  enable row level security;
alter table sap_sync_queue   enable row level security;
alter table geocode_cache    enable row level security;

-- Helpers. STABLE so the planner caches them per statement.
create or replace function current_org_id()
returns uuid language sql stable security definer set search_path = public, auth as $$
  select org_id from profiles where id = auth.uid();
$$;

create or replace function current_role_name()
returns user_role language sql stable security definer set search_path = public, auth as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public, auth as $$
  select coalesce((select role in ('sub_admin','super_admin') from profiles where id = auth.uid()), false);
$$;

create or replace function has_open_shift()
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from shifts where rider_id = auth.uid() and ended_at is null);
$$;

-- profiles ---------------------------------------------------------------------
-- A rider reads their own row. Nobody writes their own role: there is no
-- UPDATE policy granting it, so FR-AUT-003 holds structurally.
create policy profiles_self_read on profiles
  for select using (id = auth.uid());

create policy profiles_admin_read on profiles
  for select using (is_admin() and org_id = current_org_id());

create policy profiles_super_admin_write on profiles
  for all using (current_role_name() = 'super_admin' and org_id = current_org_id())
  with check (current_role_name() = 'super_admin' and org_id = current_org_id());

-- shifts -----------------------------------------------------------------------
create policy shifts_rider_own on shifts
  for select using (rider_id = auth.uid());

create policy shifts_rider_insert on shifts
  for insert with check (rider_id = auth.uid());

-- Ending a shift is the one field a rider may set on their own open shift.
create policy shifts_rider_close on shifts
  for update using (rider_id = auth.uid() and ended_at is null)
  with check (rider_id = auth.uid());

create policy shifts_admin_read on shifts
  for select using (is_admin() and exists (
    select 1 from profiles p where p.id = shifts.rider_id and p.org_id = current_org_id()
  ));

-- deliveries -------------------------------------------------------------------
-- SELECT only for riders: their assigned work, plus the unassigned pool.
-- No UPDATE policy for any client role — CON-002.
create policy deliveries_rider_read on deliveries
  for select using (
    assigned_rider_id = auth.uid()
    or (assigned_rider_id is null and status = 'CREATED' and org_id = current_org_id())
  );

create policy deliveries_admin_read on deliveries
  for select using (is_admin() and org_id = current_org_id());

-- Admins may set assignment fields. The WITH CHECK cannot reference the old
-- row, so the transition function remains the only sanctioned status writer;
-- a direct status edit here is additionally blocked by the trigger below.
create policy deliveries_admin_assign on deliveries
  for update using (is_admin() and org_id = current_org_id())
  with check (is_admin() and org_id = current_org_id());

create or replace function reject_direct_status_write()
returns trigger language plpgsql as $$
begin
  -- delivery_transition() sets this flag for the life of its transaction.
  if current_setting('trace.transition_ok', true) = '1' then
    return new;
  end if;
  if new.status is distinct from old.status then
    raise exception 'ILLEGAL_TRANSITION: status is written only by delivery_transition() (CON-002)'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger deliveries_status_guard
  before update on deliveries
  for each row execute function reject_direct_status_write();

-- delivery_events --------------------------------------------------------------
-- Read-only to clients. The transition function inserts; nobody else does.
create policy events_rider_read on delivery_events
  for select using (exists (
    select 1 from deliveries d
    where d.id = delivery_events.delivery_id and d.assigned_rider_id = auth.uid()
  ));

create policy events_admin_read on delivery_events
  for select using (is_admin() and exists (
    select 1 from deliveries d
    where d.id = delivery_events.delivery_id and d.org_id = current_org_id()
  ));

-- rider_positions --------------------------------------------------------------
-- NFR-PRV-001: a position write outside an open shift is refused by the policy
-- itself, so the privacy boundary is structural rather than a code convention.
create policy positions_rider_upsert on rider_positions
  for all using (rider_id = auth.uid() and has_open_shift())
  with check (rider_id = auth.uid() and has_open_shift());

create policy positions_admin_read on rider_positions
  for select using (is_admin() and exists (
    select 1 from profiles p where p.id = rider_positions.rider_id and p.org_id = current_org_id()
  ));

-- position_history -------------------------------------------------------------
create policy history_rider_insert on position_history
  for insert with check (exists (
    select 1 from deliveries d
    where d.id = position_history.delivery_id and d.assigned_rider_id = auth.uid()
  ));

create policy history_admin_read on position_history
  for select using (is_admin() and exists (
    select 1 from deliveries d
    where d.id = position_history.delivery_id and d.org_id = current_org_id()
  ));

-- confirmation_pins ------------------------------------------------------------
-- No policy for any client role. Verification happens server side only; the
-- hash must never be selectable. §3.5 states "None" for every column here.

-- proof_artifacts --------------------------------------------------------------
create policy proof_rider_insert on proof_artifacts
  for insert with check (exists (
    select 1 from deliveries d
    where d.id = proof_artifacts.delivery_id and d.assigned_rider_id = auth.uid()
  ));

create policy proof_rider_read on proof_artifacts
  for select using (exists (
    select 1 from deliveries d
    where d.id = proof_artifacts.delivery_id and d.assigned_rider_id = auth.uid()
  ));

create policy proof_admin_read on proof_artifacts
  for select using (is_admin() and exists (
    select 1 from deliveries d
    where d.id = proof_artifacts.delivery_id and d.org_id = current_org_id()
  ));

-- tracking_tokens / sap_sync_queue ---------------------------------------------
-- Tokens are validated by a security-definer function, never selected by a
-- client. Admins may see metadata and revoke.
create policy tokens_admin_read on tracking_tokens
  for select using (is_admin() and exists (
    select 1 from deliveries d
    where d.id = tracking_tokens.delivery_id and d.org_id = current_org_id()
  ));

create policy sap_queue_admin_read on sap_sync_queue
  for select using (is_admin() and org_id = current_org_id());

-- organisations ----------------------------------------------------------------
create policy org_member_read on organisations
  for select using (id = current_org_id());

-- Shift end erases the live position. -------------------------------------------
-- The concept note states "Go Off Shift = GPS stops, live position record
-- deleted" and §09 presents that as structural rather than procedural. Setting
-- ended_at does not cascade — the shift row still exists — so without this the
-- last known position of an off-duty rider stays readable by admins.
create or replace function erase_position_on_shift_end()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.ended_at is not null and old.ended_at is null then
    delete from rider_positions where rider_id = new.rider_id;
  end if;
  return new;
end;
$$;

create trigger shifts_erase_position
  after update on shifts
  for each row execute function erase_position_on_shift_end();

-- Moving the geofence is an auditable act. --------------------------------------
-- deliveries_admin_assign cannot restrict columns, so an admin could widen
-- geofence_radius_m to 5 km, let a rider close from anywhere, and restore it
-- leaving no trace: only status changes are audited. This records the change.
create or replace function audit_geofence_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.destination_lat   is distinct from old.destination_lat
  or new.destination_lng   is distinct from old.destination_lng
  or new.geofence_radius_m is distinct from old.geofence_radius_m then
    insert into delivery_events (
      delivery_id, from_status, to_status, actor_type, actor_id, meta
    ) values (
      new.id, old.status, old.status,
      case when current_role_name() = 'rider' then 'rider' else 'admin' end::actor_type,
      auth.uid(),
      jsonb_build_object(
        'kind', 'geofence_amended',
        'from', jsonb_build_object('lat', old.destination_lat, 'lng', old.destination_lng,
                                   'radius_m', old.geofence_radius_m),
        'to',   jsonb_build_object('lat', new.destination_lat, 'lng', new.destination_lng,
                                   'radius_m', new.geofence_radius_m)
      )
    );
  end if;
  return new;
end;
$$;

create trigger deliveries_geofence_audit
  after update on deliveries
  for each row execute function audit_geofence_change();

-- ============================================================
-- migrations/0004_transition_fn.sql
-- ============================================================
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
  -- Two identity sources, both of them real Supabase sessions. Staff and riders
  -- have a profile row. Recipients sign in anonymously and hold no profile at
  -- all — their authority comes from a tracking_sessions binding created by
  -- claim_tracking_token(), which names the one delivery they may act on.
  if auth.uid() is null then
    perform raise_trace_error('UNAUTHENTICATED');
  end if;

  select role, org_id into v_role, v_org
    from profiles where id = auth.uid() and is_active;

  if v_role is not null then
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
  else
    v_track_claim := tracking_delivery();
    if v_track_claim is null then
      perform raise_trace_error('UNAUTHENTICATED');
    end if;
    v_actor := 'recipient'::actor_type;
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

  -- Disarm immediately. set_config(..., true) lasts the whole transaction, so
  -- leaving it set means every later statement in the same transaction can write
  -- status directly — the guard would protect only callers who had not already
  -- made one legitimate transition. The window is one statement wide by design.
  perform set_config('trace.transition_ok', '0', true);

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

-- ============================================================
-- migrations/0005_confirmation_pin.sql
-- ============================================================
-- TRACE — Tier 1 confirmation. SRS v1.2 §5.4, FR-CNF-002 … FR-CNF-004.
--
-- v1.2 change: the OTP is now the PRIMARY confirmation path, not a fallback.
-- Reaching ARRIVED dispatches it automatically — the rider does not request it.
--
-- NFR-SEC-004: server-generated, short-lived, hashed at rest, rate-limited.
-- Plaintext is never stored, never logged, never returned by any function.

-- Issue. Called by delivery_transition() on reaching ARRIVED. -------------------
create or replace function issue_confirmation_pin(p_delivery uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pin      text;
  v_n        int;
  v_existing confirmation_pins%rowtype;
begin
  select * into v_existing from confirmation_pins where delivery_id = p_delivery;

  -- Resend cooldown. A rider tapping "send again" must not be able to bill the
  -- pilot for an SMS per tap. Mirrors PIN_RESEND_COOLDOWN_SECONDS on the client.
  if found and v_existing.last_sent_at > now() - interval '60 seconds' then
    return;
  end if;

  -- 6 digits from a CSPRNG. random() is a seeded PRNG and is documented as not
  -- cryptographically secure, so gen_random_bytes() is used instead; pgcrypto is
  -- already a dependency for crypt() below, so this costs nothing.
  --
  -- Rejection sampling rather than a plain modulo: 2^24 is not a multiple of
  -- 10^6, so `% 1000000` alone would make the low codes fractionally likelier.
  -- 16,000,000 is the largest multiple of 10^6 below 2^24.
  --
  -- Left-padded so every code is the same length — a rider reading "04821" back
  -- as "4821" is a support call we can design out.
  loop
    v_n := ('x' || encode(gen_random_bytes(3), 'hex'))::bit(24)::int;
    exit when v_n < 16000000;
  end loop;
  v_pin := lpad((v_n % 1000000)::text, 6, '0');

  insert into confirmation_pins (delivery_id, pin_hash, expires_at, last_sent_at)
  values (
    p_delivery,
    crypt(v_pin, gen_salt('bf', 8)),
    now() + interval '15 minutes',
    now()
  )
  on conflict (delivery_id) do update set
    pin_hash      = excluded.pin_hash,
    expires_at    = excluded.expires_at,
    last_sent_at  = now(),
    attempt_count = 0,        -- a fresh code gets a fresh allowance
    locked_until  = null,
    consumed_at   = null;

  -- Hand the plaintext to the SMS worker and to nothing else. The row in
  -- outbound_sms is the ONLY place it exists and it is never returned to any
  -- client. NFR-SEC-004, NFR-PRV-005.
  --
  -- The worker MUST null `body` on successful send. purge_outbound_sms() below
  -- is the backstop for anything the worker misses; without one of the two, every
  -- code ever issued accumulates in plaintext beside a recipient phone number.
  insert into outbound_sms (delivery_id, to_phone, body, purpose)
  select
    p_delivery,
    d.recipient_phone,
    'TRACE ' || d.trace_id || ': your delivery code is ' || v_pin ||
      '. Read it to the rider to confirm receipt. It expires in 15 minutes.',
    'confirmation_pin'
  from deliveries d where d.id = p_delivery;
end;
$$;

create table if not exists outbound_sms (
  id          uuid primary key default gen_random_uuid(),
  delivery_id uuid references deliveries(id) on delete cascade,
  to_phone    text not null,
  body        text not null,
  purpose     text not null,
  sent_at     timestamptz,
  attempts    integer not null default 0,
  last_error  text,
  created_at  timestamptz not null default now()
);
alter table outbound_sms enable row level security;
-- No client policy. Only the SMS Edge Function, holding the service role,
-- ever reads this table. The PIN plaintext lives here and nowhere else.

-- Backstop for the plaintext. A code is valid for 15 minutes; anything older
-- than an hour has no reason to still carry its body, sent or not. Scheduled
-- hourly via pg_cron in 0006.
create or replace function purge_outbound_sms()
returns void language sql security definer set search_path = public as $$
  update outbound_sms
     set body = '[purged]'
   where body <> '[purged]'
     and created_at < now() - interval '1 hour';
$$;

revoke all on function purge_outbound_sms() from public, anon, authenticated;

-- Verify. Called by delivery_transition() on a pin_entry confirmation. ---------
create or replace function verify_confirmation_pin(p_delivery uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row confirmation_pins%rowtype;
begin
  select * into v_row from confirmation_pins where delivery_id = p_delivery for update;

  if not found then
    perform raise_trace_error('PIN_EXPIRED');
  end if;

  -- FR-CNF-003: lockout is checked before anything else, so a locked-out
  -- caller cannot use timing against the comparison to learn about the code.
  if v_row.locked_until is not null and v_row.locked_until > now() then
    perform raise_trace_error('LOCKED_OUT',
      jsonb_build_object('locked_until', v_row.locked_until));
  end if;

  if v_row.consumed_at is not null then
    perform raise_trace_error('PIN_EXPIRED');
  end if;

  if v_row.expires_at <= now() then
    perform raise_trace_error('PIN_EXPIRED');
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{6}$' then
    perform raise_trace_error('PIN_INCORRECT',
      jsonb_build_object('attempts_left', greatest(0, 5 - v_row.attempt_count)));
  end if;

  -- crypt() compares in constant time for the bf scheme. FR-CNF-004.
  if crypt(p_pin, v_row.pin_hash) <> v_row.pin_hash then
    update confirmation_pins set
      attempt_count = attempt_count + 1,
      locked_until  = case when attempt_count + 1 >= 5
                           then now() + interval '10 minutes' else null end
    where delivery_id = p_delivery;

    perform raise_trace_error('PIN_INCORRECT',
      jsonb_build_object('attempts_left', greatest(0, 5 - (v_row.attempt_count + 1))));
  end if;

  -- Single use. FR-CNF-002.
  update confirmation_pins set consumed_at = now() where delivery_id = p_delivery;
end;
$$;

revoke all on function issue_confirmation_pin(uuid)  from public, anon, authenticated;
revoke all on function verify_confirmation_pin(uuid, text) from public, anon, authenticated;
-- Both are called only from inside delivery_transition(), which is itself
-- SECURITY DEFINER. No client may invoke them directly.

-- Rider-initiated resend. The ONLY PIN entry point a client may call, and it
-- returns a masked number so the rider can say which handset to check —
-- never the code itself.
create or replace function resend_confirmation_pin(p_delivery uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_delivery deliveries%rowtype;
  v_row      confirmation_pins%rowtype;
begin
  select * into v_delivery from deliveries where id = p_delivery;
  if not found or v_delivery.assigned_rider_id is distinct from auth.uid() then
    perform raise_trace_error('FORBIDDEN_ACTOR');
  end if;
  if v_delivery.status <> 'ARRIVED' then
    perform raise_trace_error('ILLEGAL_TRANSITION');
  end if;

  select * into v_row from confirmation_pins where delivery_id = p_delivery;
  if found and v_row.last_sent_at > now() - interval '60 seconds' then
    perform raise_trace_error('RATE_LIMITED', jsonb_build_object(
      'retry_after_s', 60 - extract(epoch from (now() - v_row.last_sent_at))::int));
  end if;

  perform issue_confirmation_pin(p_delivery);

  select * into v_row from confirmation_pins where delivery_id = p_delivery;
  return jsonb_build_object(
    'sent_to',       regexp_replace(v_delivery.recipient_phone, '(\d{4})\d+(\d{2})', '\1*****\2'),
    'expires_at',    v_row.expires_at,
    'attempts_left', greatest(0, 5 - v_row.attempt_count)
  );
end;
$$;

revoke all on function resend_confirmation_pin(uuid) from public, anon;
grant execute on function resend_confirmation_pin(uuid) to authenticated;

-- ============================================================
-- migrations/0006_tracking_tokens.sql
-- ============================================================
-- TRACE — customer tracking access. SRS §5.3.2, FR-CNF-001.
--
-- The recipient has no account and must still get a live map and a Received
-- button. Proxying their reads through a service-role endpoint would secure it
-- and kill Realtime, and the moving rider is the point of the link.
--
-- APPROACH. A long random token in the URL, stored only as a SHA-256 hash. The
-- recipient signs in anonymously — a real Supabase session, so Realtime and
-- PostgREST both work normally — and then exchanges the token for a row in
-- tracking_sessions binding that session to exactly one delivery. Every
-- recipient policy reads that binding.
--
-- WHY NOT A SELF-MINTED JWT WITH A CUSTOM CLAIM. This project signs with ES256
-- and Supabase holds the private key, so no shared secret exists to sign with.
-- The binding table reaches the same place without one, and has the advantage
-- that revocation is immediate rather than waiting out a token's lifetime.
--
-- SHA-256 rather than bcrypt for the token: it must be *looked up* by hash,
-- which a deliberately-slow salted KDF cannot do. 256 bits of randomness has no
-- dictionary to attack, so a fast digest is the right tool.

create extension if not exists "pgcrypto";

-- Issue. Returns the plaintext ONCE; never recoverable afterwards. ------------
create or replace function issue_tracking_token(p_delivery uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions, auth
as $$
declare
  v_token    text;
  v_delivery deliveries%rowtype;
begin
  select * into v_delivery from deliveries where id = p_delivery;
  if not found then
    perform raise_trace_error('FORBIDDEN_ACTOR');
  end if;
  if not is_admin() or v_delivery.org_id is distinct from current_org_id() then
    perform raise_trace_error('FORBIDDEN_ACTOR');
  end if;

  -- 32 bytes, base64url. Non-sequential and long enough that enumeration is not
  -- a threat model — NFR-SEC-011.
  v_token := translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');

  -- One live token per delivery: re-issuing revokes the previous one, so a
  -- forwarded link cannot outlive the resend that replaced it.
  update tracking_tokens set revoked_at = now()
    where delivery_id = p_delivery and revoked_at is null;

  insert into tracking_tokens (delivery_id, token_hash, expires_at)
  values (
    p_delivery,
    encode(digest(v_token, 'sha256'), 'hex'),
    now() + interval '7 days'
  );

  return v_token;
end;
$$;

revoke all on function issue_tracking_token(uuid) from public, anon;
grant execute on function issue_tracking_token(uuid) to authenticated;

-- The session binding. ---------------------------------------------------------
create table tracking_sessions (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  delivery_id uuid not null references deliveries(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index tracking_sessions_delivery_idx on tracking_sessions(delivery_id);

alter table tracking_sessions enable row level security;
-- A recipient may confirm which delivery their own session is bound to, and
-- nothing else. Writes happen only inside claim_tracking_token().
create policy tracking_sessions_self_read on tracking_sessions
  for select using (user_id = auth.uid());

-- Claim. Called by the recipient's anonymous session, once, on page load. ------
create or replace function claim_tracking_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, auth
as $$
declare
  v_delivery uuid;
begin
  if auth.uid() is null then
    perform raise_trace_error('UNAUTHENTICATED');
  end if;

  select t.delivery_id into v_delivery
    from tracking_tokens t
   where t.token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and t.revoked_at is null
     and t.expires_at > now()
   limit 1;

  if v_delivery is null then
    -- One answer for unknown, expired and revoked alike: a caller probing
    -- tokens learns only valid or not.
    perform raise_trace_error('FORBIDDEN_ACTOR');
  end if;

  insert into tracking_sessions (user_id, delivery_id, expires_at)
  values (auth.uid(), v_delivery, now() + interval '12 hours')
  on conflict (user_id) do update
    set delivery_id = excluded.delivery_id,
        expires_at  = excluded.expires_at;

  return v_delivery;
end;
$$;

revoke all on function claim_tracking_token(text) from public, anon;
grant execute on function claim_tracking_token(text) to authenticated;

-- What a session is bound to right now. Used by every recipient policy. -------
create or replace function tracking_delivery()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select delivery_id from tracking_sessions
   where user_id = auth.uid() and expires_at > now();
$$;

-- Link state, for the page shell. ----------------------------------------------
-- A token revoked at CONFIRMED is indistinguishable from one that never existed
-- as far as authorisation is concerned — correct for security, wrong for the
-- recipient, who would be told "not found" seconds after confirming and read it
-- as the system losing their delivery.
--
-- This separates those two cases and only those two. A closed link discloses
-- that it closed and when. Never the address, the recipient, or the rider.
create or replace function tracking_token_state(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_state jsonb;
begin
  select case
           when t.revoked_at is not null or t.expires_at <= now()
             then jsonb_build_object(
               'state',        'closed',
               'trace_id',     d.trace_id,
               'status',       d.status,
               'completed_at', d.completed_at)
           else jsonb_build_object('state', 'valid')
         end
    into v_state
    from tracking_tokens t
    join deliveries d on d.id = t.delivery_id
   where t.token_hash = encode(digest(p_token, 'sha256'), 'hex')
   order by t.revoked_at nulls first
   limit 1;

  return coalesce(v_state, jsonb_build_object('state', 'invalid'));
end;
$$;

revoke all on function tracking_token_state(text) from public;
grant execute on function tracking_token_state(text) to anon, authenticated;

-- Revoke on completion. --------------------------------------------------------
-- Decision of 19 August: the link dies at CONFIRMED. Sessions bound to it die
-- with it, which a self-minted JWT could not have delivered — an issued token
-- stays valid until it expires no matter what the server decides afterwards.
create or replace function revoke_token_on_confirmed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'CONFIRMED' and old.status is distinct from 'CONFIRMED' then
    update tracking_tokens set revoked_at = now()
      where delivery_id = new.id and revoked_at is null;
    delete from tracking_sessions where delivery_id = new.id;
  end if;
  return new;
end;
$$;

create trigger deliveries_revoke_token
  after update on deliveries
  for each row execute function revoke_token_on_confirmed();

-- Recipient reads. -------------------------------------------------------------
-- One delivery, and the rider's position only while it is theirs to watch:
-- ACCEPTED..DELIVERED per the decision of 19 August.
create policy deliveries_recipient_read on deliveries
  for select using (id = tracking_delivery());

create policy events_recipient_read on delivery_events
  for select using (delivery_id = tracking_delivery());

create policy positions_recipient_read on rider_positions
  for select using (
    exists (
      select 1 from deliveries d
       where d.id = tracking_delivery()
         and d.assigned_rider_id = rider_positions.rider_id
         and d.status in ('ACCEPTED','AT_PICKUP','PICKED_UP','IN_TRANSIT','ARRIVED')
    )
  );

-- Scheduled maintenance. -------------------------------------------------------
-- Anonymous sign-in creates a real auth user per recipient. Left alone they
-- accumulate forever, so expired bindings and their users are swept.
create or replace function purge_tracking_sessions()
returns void language plpgsql security definer set search_path = public, auth as $$
begin
  delete from auth.users u
   where u.is_anonymous
     and u.created_at < now() - interval '2 days'
     and not exists (
       select 1 from tracking_sessions s
        where s.user_id = u.id and s.expires_at > now()
     );
  delete from tracking_sessions where expires_at < now();
end;
$$;

revoke all on function purge_tracking_sessions() from public, anon, authenticated;

-- pg_cron is available on Supabase but not enabled by default.
create extension if not exists pg_cron;

select cron.schedule(
  'purge-outbound-sms', '7 * * * *',
  $cron$ select purge_outbound_sms(); $cron$
);

select cron.schedule(
  'purge-tracking-sessions', '23 3 * * *',
  $cron$ select purge_tracking_sessions(); $cron$
);

-- ============================================================
-- migrations/0007_delivery_health.sql
-- ============================================================
-- TRACE — delivery health. SRS §5.1, concept note §5.4.
--
-- deliveries.health is a stored column that nothing ever writes, so every
-- delivery has read 'green' since the schema was created. The wallboard exists
-- to say where attention is required; against a column fixed at green it says
-- nothing at all.
--
-- Computed in a view rather than maintained by a job, so the dashboard, the
-- wallboard and any later report cannot disagree. There is one definition of
-- late and it lives here. Recomputing on read costs nothing at pilot volume and
-- removes a whole class of staleness bug.
--
-- Thresholds are per-organisation, read from organisations.settings, defaulting
-- to the rule agreed on 19 August: amber past 5 minutes, red past 15.

create or replace view deliveries_with_health as
select
  d.*,
  case
    -- Terminal states are not late; they are finished.
    when d.status in ('CONFIRMED','FAILED','RETURNED') then 'green'::delivery_health
    when d.eta_at is null                              then 'green'::delivery_health
    when now() > d.eta_at + make_interval(mins => coalesce(
           (o.settings->>'health_red_minutes')::int, 15))
      then 'red'::delivery_health
    when now() > d.eta_at + make_interval(mins => coalesce(
           (o.settings->>'health_amber_minutes')::int, 5))
      then 'amber'::delivery_health
    else 'green'::delivery_health
  end as computed_health,
  -- Signed, so the dashboard can say "12 minutes early" as readily as late.
  case when d.eta_at is null then null
       else round(extract(epoch from (now() - d.eta_at)) / 60)::int
  end as minutes_late
from deliveries d
join organisations o on o.id = d.org_id;

-- security_invoker: the view runs with the caller's rights, so the RLS policies
-- on deliveries apply through it. Without this a view owned by postgres would
-- hand every reader every row — the classic way an RLS matrix is silently
-- bypassed by the convenience layer built on top of it.
alter view deliveries_with_health set (security_invoker = on);

grant select on deliveries_with_health to authenticated;

-- Wallboard counters. -----------------------------------------------------------
-- One round trip for the numbers a dispatcher reads from three metres, rather
-- than fetching every row to count it in the browser.
create or replace function delivery_health_summary()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'active',    count(*) filter (where status not in ('CONFIRMED','FAILED','RETURNED')),
    'amber',     count(*) filter (where computed_health = 'amber'),
    'red',       count(*) filter (where computed_health = 'red'),
    'completed_today', count(*) filter (
      where status = 'CONFIRMED' and completed_at >= date_trunc('day', now())
    )
  )
  from deliveries_with_health;
$$;

grant execute on function delivery_health_summary() to authenticated;

-- ============================================================
-- migrations/0008_grants.sql
-- ============================================================
-- TRACE — table privileges. SRS §3.5.
--
-- RLS and GRANT answer different questions. A policy decides WHICH ROWS a role
-- may see; a grant decides whether it may address the table at all. Without
-- both, every query returns "permission denied" no matter how correct the
-- policies are — and the policies here are the entire security story, so they
-- need to be the thing that actually runs.
--
-- Granted explicitly rather than with GRANT ... ON ALL TABLES. Two tables must
-- never be readable by any client under any circumstances, and a blanket grant
-- would hand them over while leaving RLS as the only thing standing in the way.
-- Defence in depth means the grant should also be wrong to have.
--
-- Runs after 0002, which revokes UPDATE and DELETE on the audit tables. Nothing
-- here re-grants them.

grant usage on schema public to anon, authenticated;

-- Reads. Every one of these is row-filtered by a policy in 0003 or 0006.
grant select on
  organisations,
  profiles,
  deliveries,
  delivery_events,
  shifts,
  rider_positions,
  position_history,
  proof_artifacts,
  tracking_tokens,
  sap_sync_queue,
  transition_rules,
  tracking_sessions
to authenticated;

-- Writes, each matching an INSERT or UPDATE policy that scopes it.
--   shifts            a rider opens their own and closes it
--   rider_positions   upserted while on shift, deleted when the shift ends
--   position_history  breadcrumb segments for the rider's own deliveries
--   proof_artifacts   Tier 3 evidence, insert-only by design
--   deliveries        admins set assignment fields; status is trigger-guarded
grant insert, update on shifts to authenticated;
grant insert, update, delete on rider_positions to authenticated;
grant insert on position_history to authenticated;
grant insert on proof_artifacts to authenticated;
grant update on deliveries to authenticated;

-- Sequences backing the bigserial keys, or inserts fail on nextval().
grant usage on sequence delivery_events_id_seq to authenticated;
grant usage on sequence position_history_id_seq to authenticated;

-- DELIBERATELY NOT GRANTED, to any client role:
--
--   confirmation_pins  holds the PIN hash. §3.5 states "None" for every column.
--                      Verification happens inside verify_confirmation_pin().
--   outbound_sms       holds the PIN plaintext until the worker sends it.
--   geocode_cache      written and read by server-side code only.
--
-- These have no policy either, so they are default-denied twice over.

