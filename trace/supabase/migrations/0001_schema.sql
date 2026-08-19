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
-- v1.2: recipient_tap withdrawn; the tracking page is view-only.
create type confirmation_method as enum ('pin_entry','signature','photograph');

create table organisations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
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
  confirmation_tier   smallint check (confirmation_tier in (1,2)),
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
