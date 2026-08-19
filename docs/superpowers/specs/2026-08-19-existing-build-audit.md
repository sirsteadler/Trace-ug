# Audit — existing `trace/` build

**Date:** 19 August 2026
**Scope:** `trace/supabase/migrations/0001`–`0005`
**Auditor's note:** the build references an **SRS v1.2** which is not present on disk.
Per decision on 19 August, the approved design specification supersedes it. Clause
references below are quoted from the code's own comments, not verified against a document.

---

## Verdict

The migrations are **good work and should be kept**. The architecture independently arrived at
the same decision this project's design specification did — a `SECURITY DEFINER` Postgres
function over RPC — for the same reason, and its README flags that as a deviation from its own
SRS rather than hiding it.

Three things in it are **better** than the approved spec and are adopted:

1. **Guard order** — auth → idempotency → legality → geofence. Checking legality first would
   reject the very replay idempotency exists to make safe. The spec had authorisation and
   idempotency the other way round.
2. **Token hashing** — `tracking_tokens.token_hash` rather than storing the token itself.
3. **Anomaly annotation** — mock-provider flag, unreliable-accuracy flag and impossible-speed
   detection, recorded rather than rejected. "Accept and flag" is right: a false rejection
   strands a rider in the field.

Twelve defects follow, ordered by severity.

---

## Critical

### C1 — Privilege escalation via `sender` role
`0004_transition_fn.sql:105`

```sql
v_actor := case when v_role = 'rider' then 'rider'::actor_type else 'admin'::actor_type end;
```

`user_role` has four values: `rider`, `sub_admin`, `super_admin`, **`sender`**. Anything not
`rider` collapses to actor `admin`, so a `sender` account gains every admin transition right —
assign, cancel, mark failed — on any delivery in the system. Note the delivery lookup at
`:107` has no `org_id` filter either, so this is not even scoped to their organisation.

**Fix:** map roles explicitly and reject unmapped ones; add `org_id = current_org_id()` to the
delivery lookup for non-rider actors.

### C2 — No row lock; concurrent transitions race
`0004_transition_fn.sql:107`

```sql
select * into v_delivery from deliveries where id = (payload->>'delivery_id')::uuid;
```

No `FOR UPDATE`. Two concurrent calls both read `ARRIVED`, both pass legality, both write.
The idempotency index stops a duplicate of the *same* action; it does nothing about two
*different* actions — a rider closing while dispatch marks `FAILED`. The result is two audit
rows and a last-writer-wins status.

**Fix:** `select * into v_delivery from deliveries where id = … for update;`

### C3 — PIN is not generated from a CSPRNG
`0005_confirmation_pin.sql:28-30`

The comment says "from a CSPRNG". The code is `floor(random() * 1000000)`. PostgreSQL's
`random()` is a seeded PRNG and is explicitly documented as not cryptographically secure. An
attacker who can observe or influence sequence state can predict subsequent codes.

`pgcrypto` is already installed (`0001:4`), so `gen_random_bytes()` is available at no cost.
The five-attempt lockout keeps practical risk low, but the comment asserts the opposite of what
the code does, and that is worse than silence.

### C4 — PIN plaintext is never deleted
`0005_confirmation_pin.sql:47-49`

> "The row in `outbound_sms` is the ONLY place it exists, **it is deleted on send**"

No deletion exists. The table has a `sent_at` column, implying update-on-send, and the SMS
worker is not built. Every confirmation code issued accumulates in plaintext, indefinitely,
alongside the recipient's phone number.

**Fix:** the worker must null `body` (or delete the row) on successful send, and a scheduled
purge must clear anything older than an hour regardless of send state.

---

## High

### H1 — `sync_queue` is all-or-nothing across *all* deliveries
`0004_transition_fn.sql:279-304`

The approved design is atomic **per delivery**, so a bad chain on TRC-2044 cannot block
TRC-2048. This implementation wraps every action in one transaction, so a single rejected
action discards a whole shift's queued work across every delivery in the batch.

**Fix:** group by `delivery_id` and call once per group, or have the client batch per delivery.

### H2 — Chain failures lose their error code and index
`0004_transition_fn.sql:298-303`

`when others` re-raises a generic `CHAIN_CONFLICT` with `sqlerrm` flattened into text. The
structured code (`OUTSIDE_GEOFENCE`, `PIN_INCORRECT`) and the index of the failing action are
both lost. The agreed behaviour is that the rider sees **which** action was rejected and
**why**; this cannot deliver that.

**Fix:** track loop index, re-raise with `detail` carrying `{index, code, …}`.

### H3 — Ending a shift does not delete the live position
`0003_rls.sql:126-136`, `0001_schema.sql:99-107`

The concept note §5.2 states "Go Off Shift = GPS stops, **live position record deleted**", and
§09 presents this as a structural guarantee aligned with the Data Protection and Privacy Act.
Closing a shift sets `shifts.ended_at`; nothing deletes `rider_positions`. The `on delete
cascade` fires only if the shift **row** is deleted. `positions_admin_read` has no shift
condition, so an admin can still see a rider's last position after they go off shift.

This is a published privacy claim that the code does not implement.

**Fix:** trigger on `shifts` update — when `ended_at` becomes non-null, delete the rider's
`rider_positions` row.

### H4 — `service_role` retains grants on the audit log
`0002_audit_append_only.sql:27-28`

Revokes cover `public`, `anon`, `authenticated` — not `service_role`, which every Edge Function
holds. The trigger still fires regardless of role, so this is a defence-in-depth gap rather
than an open hole, but the file's own stated principle is two independent mechanisms, and here
only one applies to the most privileged key in the system.

---

## Medium

### M1 — Admins can move the geofence without audit
`0003_rls.sql:89-91`

`deliveries_admin_assign` permits UPDATE on any column except `status` (guarded by trigger).
That includes `destination_lat`, `destination_lng` and `geofence_radius_m`, which accepts up to
5000 m. An admin can widen the fence to 5 km, let a rider close from anywhere in the city, and
restore it — leaving no audit row, because only status changes are audited.

**Fix:** restrict the policy to assignment columns, or audit destination and radius changes.

### M2 — `proof_artifacts` has no delete trigger
`0002_audit_append_only.sql:31-36`

Update is protected by trigger *and* revoke; delete only by revoke. Evidence should have the
same two mechanisms as the audit log the file argues for.

### M3 — `health` is never computed
`0001_schema.sql:68`

A stored column defaulting to `green`, written by nothing. The wallboard's GREEN/AMBER/RED —
the entire point of §5.4 exception-based monitoring — has no source. The approved spec makes
this a derived view compared against `eta_at`.

### M4 — `geocode_cache` is unreachable
`0003_rls.sql:21`, no policy

RLS enabled, no policy, so default-deny applies to every client role. Correct only if all
access goes through a `SECURITY DEFINER` function; none exists yet. Whatever populates the
cache will fail silently.

---

## Contract changes required for the three-tier ladder

The build implements a **two-tier** ladder. Restoring the customer-tap tier, as decided on
19 August, requires:

| Change | Location |
|---|---|
| Re-add `recipient_tap` to `confirmation_method` | `0001:15-16` |
| Widen `confirmation_tier` check from `(1,2)` to `(1,2,3)` | `0001:69` |
| Add `recipient` to actors on `T-11 DELIVERED → CONFIRMED` | `0004:36` |
| Recipient path in `delivery_transition` — `auth.uid()` is null under a tracking JWT, so authorisation must read the `tracking_delivery_id` claim | `0004:99-117` |
| Tracking-token validation function + scoped-JWT minting | not built |
| Re-tier: PIN becomes Tier 2, signature/photo Tier 3 | `0004:177-189`, `0005` header |

Note the interaction with `FR-STM-007` (`0004:213-219`): a flagged position currently cannot
close on Tier 2. Under the restored numbering that rule must follow the *strength* of the
proof, not the tier number — a recipient tap is weaker evidence than a PIN read aloud, so an
unreliable position should require the PIN, not merely a non-tap tier.

---

## Not built

Management dashboard · customer tracking page · SAP adapter · SMS worker Edge Function
(`outbound_sms` rows accumulate with nothing sending them) · map rendering · Web Push and its
subscription table · health computation · shift-end position deletion.

---

## Unverified

- **Whether these migrations have been applied to the Supabase project.** No `supabase/config.toml`
  exists and `projects list` reports `linked: false`, so the CLI has never pushed from here.
- **Test suite.** The README claims 29 passing tests over the queue and geofence; not run as
  part of this audit.
