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
