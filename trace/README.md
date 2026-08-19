# TRACE — Rider PWA

Phase 1 (schema) and the rider-facing half of Phases 2, 4 and 5 of the TRACE
execution plan. Built against **SRS v1.2** (v1.1 plus the two-tier confirmation
ladder change).

## What is here

```
src/lib/contract/    Types, Zod schemas, the §4.2 transition table AS DATA,
                     error codes with rider-facing copy. NFR-MNT-003: this is
                     the single source of truth the SQL mirrors.
src/lib/queue/       IndexedDB action queue. Idempotency, device-time ordering,
                     bounded thinning, quarantine of corrupt records.
src/lib/geo/         Haversine geofence, anomaly detection, adaptive ping rate,
                     device-GPS acquisition (CON-001).
src/lib/sync/        Reconnection replay. All-or-nothing batches.
src/lib/rider/       The rider write path: local first, network second.
src/lib/supabase/    Anon-key client and the RPC layer.
src/app/rider/       Login, shift + inbox, active delivery, confirmation.
supabase/migrations/ Schema, append-only audit, RLS, state machine, OTP.
```

## Setup

1. **Environment.** Copy the example and fill it in from Supabase →
   Project Settings → API:

   ```bash
   cp .env.local.example .env.local
   ```

   > **Only the anon key.** The service-role key must never appear in this
   > repository or in any `NEXT_PUBLIC_` variable (`NFR-SEC-012`). Safety rests
   > on the RLS policies in `supabase/migrations/0003_rls.sql`.

2. **Database.** Run the migrations in order in the Supabase SQL editor, or:

   ```bash
   supabase db push
   ```

   | File | What it does |
   |---|---|
   | `0001_schema.sql` | Tables, enums, indexes |
   | `0002_audit_append_only.sql` | Two independent append-only mechanisms |
   | `0003_rls.sql` | Row-level security + the direct-status-write guard |
   | `0004_transition_fn.sql` | The state machine, geofence, idempotency |
   | `0005_confirmation_pin.sql` | Tier 1 OTP: issue, verify, resend |

3. **Auth.** Enable the Phone provider in Supabase → Authentication → Providers
   and connect an SMS gateway. Riders sign in by phone + OTP; no rider password
   exists.

4. **Run.**

   ```bash
   npm install
   npm run dev
   ```

## Verification

```bash
npm run verify     # typecheck + lint + tests
```

29 tests cover the two modules where a defect is most expensive: the offline
queue (ordering, idempotency, rejection retention, bounded thinning, corrupt-
record quarantine) and the geofence (boundary cases, indeterminate-is-not-
outside, anomaly detection, backwards clocks).

## Confirmation flow (v1.2)

Two tiers, not three:

1. **PIN** — rider taps *Arrived* → the server SMSes a 6-digit code to the
   recipient automatically → they read it aloud → rider enters it → `DELIVERED`
   and `CONFIRMED` in one transaction.
2. **Signature / photo** — used when the phone is unreachable or the code never
   came. Ends at `DELIVERED`, **not** `CONFIRMED`: only the recipient's own code
   proves the recipient. Dispatch sees these as "delivered, unconfirmed".

Both tiers are geofence-gated server side. The PIN proves *who*; the geofence
proves *where*.

## Two decisions awaiting ratification

1. **The transition is a Postgres `SECURITY DEFINER` function over RPC**, not an
   Edge Function as SRS §6.1 states. `FR-STM-005` needs the status update and
   audit insert to be atomic — free in Postgres, faked in an Edge Function.
   Edge Functions remain for SMS and SAP write-back, which need network egress.

2. **`FR-STM-008` guard order is wrong.** It specifies
   auth → legality → idempotency. A replayed action has already moved the
   delivery on, so a legality check first rejects the very replay `FR-STM-004`
   exists to make safe. Implemented as auth → **idempotency** → legality →
   geofence. Nothing leaks: the caller is authorised before either check runs.

## Not built yet

Management dashboard, customer tracking page, SAP adapter, SMS worker Edge
Function (`outbound_sms` rows are written but nothing sends them yet), map
rendering on the delivery screen.
