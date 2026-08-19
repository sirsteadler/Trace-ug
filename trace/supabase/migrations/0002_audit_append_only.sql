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
revoke update, delete on delivery_events from public;
revoke update, delete on delivery_events from anon, authenticated;

-- proof_artifacts is evidence too: it may be inserted and read, never rewritten.
create trigger proof_artifacts_no_update
  before update on proof_artifacts
  for each row execute function reject_audit_mutation();

revoke update, delete on proof_artifacts from public;
revoke update, delete on proof_artifacts from anon, authenticated;
