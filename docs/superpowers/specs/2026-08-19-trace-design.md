# TRACE — Delivery Tracking & Verification Platform
## Design Specification

**Date:** 19 August 2026
**Status:** Approved for implementation planning
**Source documents:** `TRACE-Concept-Note.pdf` (14pp), `TRACE_Coding_Instructions.md`
**Delivery window:** 18–30 August 2026

---

## 1. Purpose and scope

TRACE is a delivery tracking and verification platform built on one principle: a delivery is
complete when the system can prove it was received, not when the rider says so.

This document specifies the full production MVP — every item in §15 of the concept note,
hardened for real riders and real deliveries. It is the frozen contract that three parallel
workstreams build against.

### 1.1 In scope

Three interfaces (rider, customer, management) · SAP ByDesign adapter with a demonstrable
integration path · live GPS tracking · ETA · click-to-call · three-tier confirmation ·
geofenced completion · proof of delivery · offline action queue · management dashboard ·
TV wallboard · full security model.

### 1.2 Out of scope

Multi-stop routing · automated dispatch optimisation · payments and wallets · marketplace
features · loyalty and pricing · AI features · advanced analytics · multi-organisation
tenancy · Play Store publication · live SAP tenant binding.

Each excluded item is a defensible Phase 2 addition. None is required to prove the platform
works.

---

## 2. Decisions taken

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Deliverable | Full production MVP | User directive. Timeline risk recorded in §13. |
| 2 | State machine | Concept note §07 | Separates handover from verification; required for Tier 3. |
| 3 | Cancellation | `FAILED` + reason code | Keeps the frozen contract identical to the published document. |
| 4 | Validation location | Postgres core (A) | Transition + audit row commit in one transaction. |
| 5 | Customer auth | Scoped JWT | Only option preserving Realtime without creating junk accounts. |
| 6 | Position visibility | `ACCEPTED` → `DELIVERED` | User choice; mitigated by coarse position before `PICKED_UP`. |
| 7 | Staff auth | Phone + OTP for all roles | One auth path; matches §09 as written. |
| 8 | Tracking link expiry | Revoked at `CONFIRMED` | User choice; mitigated by a designed closed-link screen. |
| 9 | Replay rejection | Block chain, surface to rider | Never fabricate a sequence the rider did not perform. |
| 10 | Rider platform | Android-first, iOS best-effort | Matches the Ugandan rider market. |
| 11 | Device retention | Failed 7d, synced 24h | Forensic value without unbounded growth. |
| 12 | SMS provider | Africa's Talking | Cheaper and more reliable to UG numbers. |
| 13 | SAP import | Scheduled poll + manual button | Works with no inbound tenant configuration. |
| 14 | Notifications | Web Push + in-app Realtime | Rider must be reachable with the app closed. |
| 15 | Hosting | Vercel + free subdomain | Zero cost, automatic HTTPS, no registrar dependency. |
| 16 | Mapping | Provider abstraction | Google billing is unconfirmed; fallback protects the demo. |
| 17 | Components | shadcn/ui | Source-in-repo, no library fighting the tokens. |
| 18 | Health rules | Minutes past ETA | AMBER >5min, RED >15min, configurable. |
| 19 | Design process | Code-first with tokens | Day 2 of 13; a working screen beats a frame of one. |
| 20 | Testing | Security + demo path | Covers exactly the claims under evaluation. |

---

## 3. Architecture

```
SAP Business ByDesign  (no tenant available — mock-backed)
        │  OData/A2X
        ▼
ByD Adapter  (Edge Function · contract-first · sole holder of SAP credentials)
        │  internal contract
        ▼
Postgres core  (schema · RLS · state machine · immutable audit log)
        │
        ├── Edge Functions ── SMS (Africa's Talking) · Web Push · SAP outbox worker
        │
        └── Supabase Realtime
                 │
    ┌────────────┼────────────┐
    ▼            ▼            ▼
  RIDER       CUSTOMER    MANAGEMENT
  PWA         link        dashboard + wallboard
```

**The dividing line:** anything that must be *true* lives in Postgres. Anything that talks to
a third party lives in an Edge Function. Next.js serves UI and sessions and holds no business
logic.

Rider position originates on the device. Google Maps supplies tiles, geocoding and routing and
is never asked where the rider is.

---

## 4. Data model

Schema `trace`, PostgreSQL with PostGIS.

| Table | Purpose | Key columns |
|---|---|---|
| `organisations` | RLS scope root | `id`, `name` |
| `profiles` | Identity + role | `id`→`auth.users`, `org_id`, `role`, `phone` |
| `deliveries` | Current state | `status`, `destination geography(Point,4326)`, `geofence_radius_m` (default 100), `assigned_rider_id`, `sap_delivery_note_id`, `eta` |
| `delivery_events` | **Immutable audit log** | `seq`, `from_status`, `to_status`, `actor_id`, `actor_role`, `position`, `gps_accuracy_m`, `device_time`, `server_time`, `client_event_id`, `reason_code` |
| `delivery_transitions` | Legal moves **as data** | `from_status`, `to_status`, `allowed_roles[]` |
| `shifts` | GPS boundary | `rider_id`, `started_at`, `ended_at` |
| `rider_live_positions` | Current position | Row **deleted** at shift end |
| `delivery_breadcrumbs` | History | 60-second batched segments |
| `confirmation_pins` | Tier 2 | `pin_hash`, `expires_at`, `attempts`, `max_attempts` |
| `proof_artifacts` | Tier 3 | `kind`, storage path |
| `tracking_tokens` | Customer access | Long random, non-sequential, `revoked_at` |
| `push_subscriptions` | Web Push | VAPID subscription per rider device |
| `sap_outbox` | Write-back queue | `attempts`, `next_attempt_at`, `last_error`, `status` |
| `geocode_cache` | Cost control | Normalised address → point |

`org_id` exists on every table from day one. Multi-tenancy is out of scope, but retrofitting a
scope column later means migrating live audit data.

### 4.1 Audit immutability

Enforced twice:

1. `REVOKE UPDATE, DELETE ON trace.delivery_events FROM authenticated, anon, service_role`
2. A `BEFORE UPDATE OR DELETE` trigger that raises

The `service_role` revoke is the one that matters — Edge Functions hold that key, and without
it "append-only" is a convention rather than a guarantee.

### 4.2 Delivery health

A `delivery_health` view derives GREEN / AMBER / RED from progress against `eta`
(AMBER > 5 min late, RED > 15 min, thresholds per organisation). Computed once, server-side,
so dashboard and wallboard cannot disagree.

---

## 5. State machine

```
CREATED → ASSIGNED → ACCEPTED → AT_PICKUP → PICKED_UP → IN_TRANSIT → ARRIVED → DELIVERED → CONFIRMED
                                                                         ↘ FAILED    ↘ RETURNED
```

`DELIVERED` is handover and carries the geofence check. `CONFIRMED` is verification through the
Tier 1/2/3 ladder. They are separate because Tier 3 requires it: the rider closes with a
signature or photo (`DELIVERED`) and the recipient confirms by SMS minutes later (`CONFIRMED`).
A merged state cannot express that gap, and the gap is the evidence.

`FAILED` is reachable from any non-terminal state with a mandatory reason code — this is how a
cancelled job exits, without adding a `CANCELLED` state the published document does not
contain. `RETURNED` is reachable from `FAILED` and from `ARRIVED`.

Legal transitions live in `delivery_transitions` as rows, not code. Policy changes become data
changes, and the table is directly testable.

### 5.1 The single write path

```
trace.request_transition(
    p_delivery_id     uuid,
    p_to_status       trace.delivery_status,
    p_device_time     timestamptz,
    p_position        geography(Point,4326) default null,
    p_accuracy_m      real                  default null,
    p_client_event_id uuid,
    p_reason_code     text                  default null,
    p_metadata        jsonb                 default '{}'
) returns trace.delivery_events
```

`SECURITY DEFINER`, pinned `search_path`. Sequence:

1. Lock the delivery row `FOR UPDATE`
2. **Idempotency:** if `client_event_id` already exists, return the existing event unchanged
3. Authorise the caller's role against `delivery_transitions`
4. Validate the transition is legal from the current status
5. Apply guards — `DELIVERED` requires position within `geofence_radius_m` of destination
6. Insert the event and update `deliveries.status` **in the same transaction**
7. Return the event

Clients never write status. `deliveries` has no `UPDATE` policy at all, so this function is the
only door.

### 5.2 Chain replay

`trace.replay_chain(actions jsonb)` orders by `device_time` and is **atomic per delivery** — a
bad chain on one delivery cannot block another. `device_time` must be monotonic within a chain
and must not exceed `server_time` beyond a skew allowance. Violations reject the chain and
return the index and reason of the first failing action.

---

## 6. Security model

| Control | Implementation |
|---|---|
| Identity | Phone + OTP for all roles. `role` mirrored into the JWT via the custom access-token hook. |
| Role integrity | `profiles` UPDATE cannot change `role` or `org_id`. Role changes go through an admin-only `SECURITY DEFINER` function. |
| Status integrity | Clients cannot write status. One `SECURITY DEFINER` function, no UPDATE policy. |
| Row-level security | Enabled on every table, **default deny**. No policy means no access. |
| Anti-fraud | Server-side geofence validation before `DELIVERED` is accepted. |
| Tracking links | Long random non-sequential tokens, revoked at `CONFIRMED`. |
| OTP / PIN | Server-generated, short-lived, hashed at rest, rate-limited. `confirmation_pins` has **no SELECT policy for any role**; `trace.verify_pin()` compares hashes inside the database. |
| Audit | Append-only, enforced by revoke + trigger. |
| Secrets | Service-role key and Supabase JWT secret exist only in server-side env. The browser receives one credential: the domain-restricted Maps key. |
| Location privacy | GPS runs only during an active shift. Going off shift deletes the live position row. Aligns with Uganda's Data Protection and Privacy Act, 2019. |

### 6.1 The three access paths

| Actor | Identity | Reads | Writes |
|---|---|---|---|
| Rider | Phone + OTP, `role=rider` | Own assigned deliveries, own shift and position | `request_transition` on assigned deliveries; position pings |
| Dispatcher | Phone + OTP, `role=dispatcher` | Everything within `org_id` | Create, assign, cancel, permitted transitions |
| Customer | Scoped JWT, no account | One delivery via a `security_invoker` view; assigned rider position between `ACCEPTED` and `DELIVERED` | `DELIVERED → CONFIRMED` only |

### 6.2 Customer access mechanism

`/t/<token>` → route handler validates the token → mints a 15-minute JWT signed with the
Supabase JWT secret carrying claim `tracking_delivery_id`. The browser uses it with
`supabase-js`, so Realtime works and RLS enforces scope:

```sql
using ( id = (auth.jwt() ->> 'tracking_delivery_id')::uuid )
```

Revocation stops new mints; any live token expires within 15 minutes. Tier-1 confirmation is an
ordinary `request_transition` call, not a special path.

Position shown to the customer is **coarse** (no accuracy radius, no breadcrumb history) before
`PICKED_UP`, full fidelity after.

After `CONFIRMED`, the route handler serves a designed closed-link screen — *"This delivery was
confirmed at 14:32"* — before any token check, so a completed link reads as finished rather
than broken.

---

## 7. Confirmation ladder

| Tier | Method | Notes |
|---|---|---|
| 1 | Customer taps **✓ Received** in the tracking link or installed app | Primary path. Exactly what the brief specifies. |
| 2 | Server-generated PIN sent by SMS, read aloud, entered on the rider's device | Short-lived, hashed at rest, rate-limited, attempt-capped. |
| 3 | Signature or photograph captured by the rider | Sets `DELIVERED`; an SMS then invites asynchronous `CONFIRMED`. |

**Every tier is geofence-validated.** The server rejects any completion where the rider is
outside `geofence_radius_m` of the destination.

---

## 8. Offline resilience

Offline is not a mode. The rider UI never writes to Supabase directly. Every action appends to
an IndexedDB outbox, updates local state optimistically, and a sync engine drains it. Online
and offline share one code path.

**Stores:** `outbox` (queue), `deliveries_cache` (read model), `meta` (shift state, last sync).

**Flush:** group pending actions by `delivery_id`, order by `device_time`, one `replay_chain`
RPC per delivery. Triggers: `online` event, `visibilitychange`, 20-second timer while pending,
Background Sync where available. Exponential backoff with jitter, capped at five minutes.

**Priority under queue pressure:**

| | Transitions | Breadcrumbs |
|---|---|---|
| Loss tolerance | **Never dropped** | Droppable, oldest first |
| Batching | Individual | 60-second segments |

A long dead zone must never cost a `PICKED_UP` event because GPS pings filled the quota.

**Rejection handling:** the chain rolls back, the rider sees which action was rejected and why,
and nothing is silently discarded or fabricated.

**Retention:** failed actions 7 days, synced actions purged after 24 hours.

**Adaptive ping rate** via throttled `watchPosition`: 30s in transit, 10s within 1 km, 5s inside
the geofence, off when not on shift.

**Platform limit:** Background Sync does not exist on iOS Safari. On iPhone the queue flushes
when the app is next opened.

---

## 9. Integration layer

### 9.1 ByD adapter

```ts
interface ByDAdapter {
  fetchDeliveryNotes(since: Date): Promise<ByDDeliveryNote[]>
  pushConfirmation(c: TraceConfirmation): Promise<ByDAck>
  healthCheck(): Promise<AdapterHealth>
}
```

`MockByDAdapter` runs on seeded fixtures with **injectable failures**, so the retry queue can be
demonstrated rather than described. `LiveByDAdapter` binds to a real tenant later. Selection is
one environment variable; nothing above the adapter changes.

Translation lives in its own module with golden-file tests: fixture in, expected TRACE model
out.

**Inbound:** scheduled Edge Function polls every 5 minutes, upserting on `sap_delivery_note_id`
(idempotent), plus a manual *Import now* button in the dashboard.

**Outbound:** confirmation writes a row to `sap_outbox` and commits. A worker drains it with
exponential backoff (1m → 2m → 4m, capped 1h, ~8 attempts), then parks it in a state the
dashboard renders as the visible retry queue.

**Boundary that matters:** confirmation must never depend on SAP being reachable. Write-back is
a consequence of confirmation, not a precondition for it.

### 9.2 SMS

One `SmsProvider` interface, two consumers: Supabase Auth OTP (via the Send SMS auth hook,
since Africa's Talking is not a native provider) and our own Tier-2 PIN and dispatch
notifications.

### 9.3 Push

Web Push with VAPID, subscriptions in `push_subscriptions`. Android Chrome supports it directly;
iOS requires the PWA be installed to the home screen.

---

## 10. Frontend

```
app/(rider)/r/…        installable PWA · dark · offline-capable
app/(track)/t/[token]/ no auth · one screen · <5MB
app/(dash)/d/…         responsive dashboard + /d/wall wallboard
lib/{supabase,domain,map,sms,byd,offline,design}/
```

Two manifests, one app: rider and customer PWAs need different `start_url`, `scope` and
`theme_color`. One root-scoped service worker with per-route caching strategies; the dashboard
has no offline requirement.

**Design tokens** derive from the concept note's own palette — primary `#5B2C8D`, surface
`#F4F1FA` — so the product visually matches the document the panel is holding.

| | Rider | Customer | Dashboard / Wallboard |
|---|---|---|---|
| Context | Beside a running motorcycle | One screen, cheap phone, 3G | Read at three metres, or at a desk |
| Theme | Dark by default | Light, minimal | Light / high-contrast |
| Rule | One primary action per screen, ≥56px targets, never a form | No install, no account, no scrolling | Exception-based |

**Map provider abstraction:** a thin interface over tiles, geocoding and routing. Google behind
it as §11 specifies; MapLibre + OpenFreeMap tiles and Nominatim geocoding as a drop-in fallback
if Maps billing is never attached.

---

## 11. Cost model

| Lever | Effect |
|---|---|
| Adaptive GPS ping rate | Sparse in transit, frequent near destination |
| Batched position history | 60-second segments, not one row per fix |
| Cached geocoding | Repeat destinations never re-billed |
| Throttled route recalculation | On significant deviation, not on a timer |
| Device-sourced GPS | Rider position never purchased from a mapping API |

At pilot volumes the platform operates within the free tiers of Supabase and Vercel.

**Correction required to concept note §12:** SMS is metered and is not free. At roughly 1–2
messages per delivery, expect **US$10–20/month at 1,000 deliveries**. The claim should read
*"operates within the free tiers of the chosen services, excluding SMS, which is metered at
approximately US$0.01 per delivery."* Claiming free SMS would not survive scrutiny.

---

## 12. Testing

| Layer | Coverage |
|---|---|
| SQL | A rider cannot close a delivery from 5 km away; cannot transition another rider's job; cannot write status directly; illegal transitions are rejected; audit rows cannot be updated or deleted |
| Playwright | The §16 demo scenario end to end, including offline mode |

These tests are the evidence behind the 40% technical-feasibility criterion.

---

## 13. Risks and honest limitations

| Risk | Mitigation |
|---|---|
| **Timeline** — full production MVP in 12 days with 3 developers | Recorded explicitly. Demo path front-loaded; slippage reported, not hidden. |
| GPS position is client-asserted | The server validates the claim against the geofence and records accuracy and the OS mock-location flag. **No server can cryptographically prove a device's location.** Geofencing raises falsification from trivial to deliberate — this should be stated to the panel in those terms. |
| Google Maps billing may never attach | Provider abstraction with a MapLibre fallback. |
| No local Supabase stack (Docker absent) | Migrations apply to the hosted project. A second free project should serve as staging before schema changes run over live audit data. |
| Edge Function deploy may require Docker | To verify at Phase 2; recent CLI versions deploy via API. |
| No live SAP tenant | Contract-first adapter, mock-backed, declared honestly in §08. |
| Poor field connectivity | Offline queue with server-side chain validation. |
| Scope expansion | Explicit exclusion list; contract frozen day one. |

---

## 14. Build sequence

| Phase | Output |
|---|---|
| 1 | Schema, RLS policies, audit trigger, `delivery_transitions` data, `request_transition`, `replay_chain`, SQL tests |
| 2 | Edge Functions: SMS provider, Web Push, SAP outbox worker, scheduled import |
| 3 | ByD adapter: interface, mock with fixtures, translation module, golden-file tests |
| 4 | Next.js scaffold, design tokens, shadcn/ui, three route groups, map abstraction |
| 5 | Rider PWA: offline outbox, sync engine, service worker, GPS |
| 6 | Customer tracking link, confirmation ladder, proof records |
| 7 | Dashboard, wallboard, delivery health |
| 8 | Integration, Playwright demo path, airplane-mode rehearsal |

Documentation runs in parallel from 25 August.
