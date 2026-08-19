-- TRACE — customer tracking access. SRS §5.3.2, FR-CNF-001.
--
-- The recipient has no account and must still get a live map and a Received
-- button. Proxying their reads through a service-role endpoint would secure it
-- and kill Realtime, and the moving rider is the point of the link.
--
-- So: a long random token in the URL, stored only as a SHA-256 hash. The route
-- handler exchanges it for a short-lived JWT carrying a tracking_delivery_id
-- claim, and RLS scopes every read to that one delivery.
--
-- SHA-256 rather than bcrypt deliberately: the token must be *looked up* by its
-- hash, which a deliberately-slow salted KDF cannot do. A 256-bit random token
-- has no dictionary to attack, so a fast digest is the right tool here.

create extension if not exists "pgcrypto";

-- Issue. Returns the plaintext ONCE; it is never recoverable afterwards. ------
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
  -- forwarded link cannot outlive the re-send that replaced it.
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

-- Validate. Called by the route handler before minting a scoped JWT. ----------
-- Returns the delivery id, or null. Deliberately returns null rather than
-- raising for every failure mode: a caller probing tokens learns only
-- valid/invalid, never whether a token existed, expired, or was revoked.
create or replace function validate_tracking_token(p_token text)
returns uuid
language sql
security definer
set search_path = public, extensions
as $$
  select t.delivery_id
    from tracking_tokens t
   where t.token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and t.revoked_at is null
     and t.expires_at > now()
   limit 1;
$$;

revoke all on function validate_tracking_token(text) from public;
grant execute on function validate_tracking_token(text) to anon, authenticated;

-- Link state. ------------------------------------------------------------------
-- A token revoked at CONFIRMED is indistinguishable from a token that never
-- existed, as far as validate_tracking_token is concerned — which is correct for
-- authorisation and wrong for the recipient, who would see "not found" seconds
-- after confirming and read it as the system losing their delivery.
--
-- This separates the two, and only the two. A completed link discloses that it
-- completed and when. It never discloses the address, the recipient or the rider.
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
           else jsonb_build_object('state', 'valid', 'delivery_id', d.id)
         end
    into v_state
    from tracking_tokens t
    join deliveries d on d.id = t.delivery_id
   where t.token_hash = encode(digest(p_token, 'sha256'), 'hex')
   order by t.revoked_at nulls first
   limit 1;

  -- No row and a revoked row are different things to the recipient, but an
  -- unknown token must still say nothing at all.
  return coalesce(v_state, jsonb_build_object('state', 'invalid'));
end;
$$;

revoke all on function tracking_token_state(text) from public;
grant execute on function tracking_token_state(text) to anon, authenticated;

-- Revoke on completion. --------------------------------------------------------
-- Decision of 19 August: the token dies at CONFIRMED. The route handler serves a
-- designed "confirmed at HH:MM" screen from the delivery record BEFORE checking
-- the token, so a completed link reads as finished rather than broken.
create or replace function revoke_token_on_confirmed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'CONFIRMED' and old.status is distinct from 'CONFIRMED' then
    update tracking_tokens set revoked_at = now()
      where delivery_id = new.id and revoked_at is null;
  end if;
  return new;
end;
$$;

create trigger deliveries_revoke_token
  after update on deliveries
  for each row execute function revoke_token_on_confirmed();

-- Recipient reads. -------------------------------------------------------------
-- The scoped JWT carries no auth.uid(), so these policies key off the claim.
-- One delivery, narrow columns, and the rider's position only while it is
-- theirs to see — position visibility runs ACCEPTED..DELIVERED per the decision
-- of 19 August, coarsened before PICKED_UP.
create or replace function tracking_claim()
returns uuid language sql stable set search_path = public as $$
  select nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'tracking_delivery_id', ''
  )::uuid;
$$;

create policy deliveries_recipient_read on deliveries
  for select using (id = tracking_claim());

create policy events_recipient_read on delivery_events
  for select using (delivery_id = tracking_claim());

create policy positions_recipient_read on rider_positions
  for select using (
    exists (
      select 1 from deliveries d
       where d.id = tracking_claim()
         and d.assigned_rider_id = rider_positions.rider_id
         and d.status in ('ACCEPTED','AT_PICKUP','PICKED_UP','IN_TRANSIT','ARRIVED')
    )
  );

-- Scheduled maintenance. -------------------------------------------------------
-- pg_cron is available on Supabase but not enabled by default.
create extension if not exists pg_cron;

select cron.schedule(
  'purge-outbound-sms',
  '7 * * * *',
  $cron$ select purge_outbound_sms(); $cron$
);
