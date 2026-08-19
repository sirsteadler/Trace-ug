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
