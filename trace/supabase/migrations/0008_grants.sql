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
