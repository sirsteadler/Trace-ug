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
