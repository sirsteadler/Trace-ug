# TRACE — Migration guide: Supabase to Firebase

Status: proposal. Nothing in this document has been implemented.

This guide describes how to move the TRACE backend from Supabase (Postgres, RLS,
SECURITY DEFINER functions, Deno Edge Functions) to Firebase (Firestore, Security
Rules, Cloud Functions, Firebase Auth), and how to solve the four problems that
make the move non-trivial.

It is written to be executable: every phase has a concrete deliverable and a
checkpoint you can fail on.

---

## 0. Read this first

### Scope

Roughly 3,700 lines of SQL and Supabase-coupled TypeScript are affected. The
majority of the application — the contract layer, the geofence maths, the offline
queue, the map layer, every React component — is untouched. See §10 for the
inventory.

### Honest verdict

Two of the four problems are work. Two are structural: the guarantee does not
exist on the platform and must be rebuilt somewhere else.

| Problem | Nature | Resolution |
|---|---|---|
| Auth SMS provider | Structural | Build a custom OTP flow (§3) |
| Transaction atomicity | Work | Redesign the batch replay (§4) |
| Append-only audit | Structural | Move the system of record out of Firestore (§5) |
| Blaze plan required | Friction | Enable it, cap it, reword the design doc (§6) |

### The rule that governs the whole migration

> **No client SDK ever writes a business document.**

Postgres enforced this with grants: no client role held UPDATE on
`deliveries.status`. Firestore has no grants, so the equivalent is a Security
Rules file that denies client writes on every business collection, plus callable
Cloud Functions as the only write path. Everything in this guide follows from
that rule.

### If you have not committed yet

A hybrid exists and is much cheaper: keep Supabase for data and auth, add Firebase
Cloud Messaging for push. Zero backend change. This guide assumes you have already
ruled that out.

---

## 1. Decision gate

Answer these before writing code. A "no" anywhere means stop and reconsider.

1. **Can you accept Google's SMS rates into Ugandan networks, or will you build
   and maintain a custom OTP flow?** If neither, the migration is not viable —
   there is no third option. (§3)

2. **Is a billing account with a card acceptable for the pilot?** Cloud Functions
   cannot deploy on the Spark plan, and this architecture cannot run without Cloud
   Functions. (§6)

3. **Do you accept that the audit log's immutability moves from a database grant
   to a combination of code discipline, a hash chain, and an external immutable
   store?** (§5)

4. **Do you have someone who can own Security Rules?** They are the entire
   read-side authorisation model, they are not SQL, and they fail open in ways RLS
   does not. (§8)

5. **Is there a real reason for this?** Existing Firebase estate, team fluency,
   or wanting FCM + Crashlytics + Analytics as one bundle. "Firestore is realtime"
   is not a reason — Supabase Realtime already serves every live surface in the
   app.

---

## 2. Target architecture

```
                    ┌──────────────────────────────┐
   rider PWA ──────▶│  Cloud Functions (callable)  │
   dashboard  ─────▶│                              │
   tracking page ──▶│  requestOtp / verifyOtp      │──▶ Africa's Talking
                    │  deliveryTransition          │
                    │  syncQueue                   │
                    │  createDelivery              │
                    │  issueTrackingToken          │
                    │  claimTrackingToken          │
                    │  resendConfirmationPin       │
                    └───────────┬──────────────────┘
                                │ Admin SDK, transactions
                                ▼
                    ┌──────────────────────────────┐
   all clients ────▶│  Firestore                   │  reads only,
   (onSnapshot)     │  Security Rules: writes deny │  Rules-filtered
                    └───────────┬──────────────────┘
                                │ onDocumentCreated trigger
                                ▼
                    ┌──────────────────────────────┐
                    │  GCS bucket, retention lock  │  audit system of record
                    └──────────────────────────────┘
```

Three things to notice:

- **Reads go direct to Firestore.** This is what keeps `onSnapshot` working and
  preserves the live map, the wallboard, and the rider inbox. Reads are filtered
  by Security Rules, which are the RLS replacement.
- **Writes never go direct.** Every write is a callable Function running the guard
  ladder that `delivery_transition()` runs today.
- **Audit events land in Firestore for serving and in GCS for evidence.** Firestore
  is the fast copy; GCS is the copy that cannot be rewritten.

---

## 3. Blocker 1 — Auth SMS

### The problem

Today `signInWithOtp({ phone })` causes Supabase Auth to generate an OTP, store it
hashed, rate-limit it, and call `send-sms-hook`, which forwards to Africa's
Talking. You own 77 lines. Supabase owns generation, hashing, expiry, lockout,
rate limiting, session issuance, and refresh.

Firebase Auth phone sign-in sends SMS through Google's own infrastructure. There
is no provider hook. Identity Platform allows template text and region policy
changes, not a carrier swap.

So: either accept Google's SMS, or build the OTP flow yourself and exchange it for
a Firebase session with `createCustomToken()`.

### Recommended: build it, carefully

Keeping Africa's Talking preserves decision 12 (cost and Ugandan deliverability)
and reuses the provider adapter you already have. The cost is that you now own
security-critical code guarding an endpoint that spends money.

### Collections

```
otp_requests/{phone}          # one doc per phone, not per attempt
  phone:          string      # E.164, and the document ID
  code_hash:      string      # scrypt or bcrypt. NEVER the plaintext
  expires_at:     timestamp   # now + 5 minutes; Firestore TTL policy on this
  attempt_count:  number
  locked_until:   timestamp | null
  last_sent_at:   timestamp
  send_count_1h:  number      # rolling per-phone send budget
  window_start:   timestamp

otp_ip_budget/{ipHash}        # second rate-limit axis
  count:          number
  window_start:   timestamp
  # TTL policy deletes these
```

Use the phone number as the document ID. That makes every read and write on a
given phone a single-document operation, which means the transaction serialises
attempts for that phone — which is exactly what an attempt counter needs.

### Function: `requestOtp`

```ts
// functions/src/auth/requestOtp.ts
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { hash } from './hash';           // scrypt wrapper
import { sendSms } from '../sms/provider';

const OTP_TTL_MS       = 5 * 60_000;
const RESEND_COOLDOWN  = 60_000;
const MAX_SENDS_PER_HR = 5;

export const requestOtp = onCall(
  { enforceAppCheck: true, region: 'europe-west1', secrets: ['AT_API_KEY'] },
  async (request) => {
    const phone = normaliseE164(request.data?.phone);
    if (!phone) throw new HttpsError('invalid-argument', 'bad request');

    const db  = getFirestore();
    const ref = db.collection('otp_requests').doc(phone);

    // randomInt is CSPRNG-backed and range-correct — no modulo bias to think
    // about, unlike the rejection sampling issue_confirmation_pin() had to
    // handle by hand in plpgsql.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

    const shouldSend = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now  = Date.now();

      if (snap.exists) {
        const d = snap.data()!;

        if (d.last_sent_at.toMillis() > now - RESEND_COOLDOWN) return false;

        const windowOpen = d.window_start.toMillis() > now - 3_600_000;
        if (windowOpen && d.send_count_1h >= MAX_SENDS_PER_HR) return false;

        tx.update(ref, {
          code_hash:     await hash(code),
          expires_at:    Timestamp.fromMillis(now + OTP_TTL_MS),
          attempt_count: 0,
          locked_until:  null,
          last_sent_at:  Timestamp.fromMillis(now),
          send_count_1h: windowOpen ? FieldValue.increment(1) : 1,
          window_start:  windowOpen ? d.window_start : Timestamp.fromMillis(now),
        });
        return true;
      }

      tx.set(ref, {
        phone,
        code_hash:     await hash(code),
        expires_at:    Timestamp.fromMillis(now + OTP_TTL_MS),
        attempt_count: 0,
        locked_until:  null,
        last_sent_at:  Timestamp.fromMillis(now),
        send_count_1h: 1,
        window_start:  Timestamp.fromMillis(now),
      });
      return true;
    });

    if (shouldSend) {
      await sendSms(phone, `TRACE: your sign-in code is ${code}. Expires in 5 minutes.`);
    }

    // ALWAYS the same answer. Never disclose whether the number is registered,
    // whether it was rate-limited, or whether an SMS actually went out.
    // NFR-SEC-009, and it matches what rider/login/page.tsx already renders.
    return { ok: true };
  },
);
```

Note what the return value does **not** say. The current login page already
renders one message regardless (`src/app/rider/login/page.tsx:28-30`); the server
must match that discipline or the client's care is wasted.

### Function: `verifyOtp`

```ts
export const verifyOtp = onCall(
  { enforceAppCheck: true, region: 'europe-west1' },
  async (request) => {
    const phone = normaliseE164(request.data?.phone);
    const code  = String(request.data?.code ?? '');
    if (!phone || !/^[0-9]{6}$/.test(code)) {
      throw new HttpsError('permission-denied', 'invalid');
    }

    const db  = getFirestore();
    const ref = db.collection('otp_requests').doc(phone);

    const ok = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const d = snap.data()!;
      const now = Date.now();

      // Lockout first, so a locked-out caller cannot use response timing
      // against the comparison. Mirrors verify_confirmation_pin().
      if (d.locked_until && d.locked_until.toMillis() > now) return false;
      if (d.expires_at.toMillis() <= now) return false;

      if (!(await verifyHash(code, d.code_hash))) {
        const next = (d.attempt_count ?? 0) + 1;
        tx.update(ref, {
          attempt_count: next,
          locked_until: next >= 5 ? Timestamp.fromMillis(now + 600_000) : null,
        });
        return false;
      }

      tx.delete(ref);   // single use
      return true;
    });

    if (!ok) throw new HttpsError('permission-denied', 'invalid');

    const auth = getAuth();
    const user = await auth.getUserByPhoneNumber(phone).catch(() => null);
    if (!user || user.disabled) {
      // Unregistered number: same error as a wrong code. No enumeration.
      throw new HttpsError('permission-denied', 'invalid');
    }

    const profile = await db.collection('profiles').doc(user.uid).get();
    if (!profile.exists || profile.data()!.is_active !== true) {
      throw new HttpsError('permission-denied', 'invalid');
    }

    return { token: await auth.createCustomToken(user.uid) };
  },
);
```

The client then calls `signInWithCustomToken(token)`. From that point Firebase Auth
handles session persistence and refresh — that part is genuinely free.

### Custom claims replace the RLS helper functions

`current_org_id()`, `current_role_name()` and `is_admin()` are SQL functions today
because RLS policies can run a subquery. Security Rules cannot do joins cheaply, so
role and org must live in the ID token:

```ts
await getAuth().setCustomUserClaims(uid, { role: 'rider', org: orgId });
```

Set this whenever a profile is created or its role changes.

**Propagation lag.** Claims reach the client only on token refresh, up to one hour.
Two consequences:

- After a role change, call `user.getIdToken(true)` on the client, or
  `revokeRefreshTokens(uid)` server-side to force it.
- **Never trust claims inside a Cloud Function for an authorisation decision that
  must be immediate.** Functions should re-read `profiles/{uid}` — a server-side
  read is always current. Claims are for Security Rules, which have no other
  option.

### Abuse protection

`send-sms-hook/index.ts:8-14` states the threat plainly: without its signature
check, "this would send an SMS to any number anyone posted, at your expense."
Supabase protects it with a shared secret because the only legitimate caller is
Supabase Auth itself.

Your `requestOtp` has no such luxury — a rider must reach it before they have a
session. Layer what you can:

1. **App Check** with Play Integrity (Android) and reCAPTCHA Enterprise (web),
   `enforceAppCheck: true`. Attests the call came from your real app. Bypassable by
   a determined attacker with your binary, but it stops casual abuse.
2. **Per-phone budget** — the `send_count_1h` field above.
3. **Per-IP budget** — a separate axis, because an attacker rotates phone numbers.
   Hash the IP; do not store it raw.
4. **A billing alarm on Africa's Talking**, not just on GCP.

The realistic failure mode is not account takeover. It is someone draining your SMS
balance at roughly $0.01 a message.

### Recipient anonymous sessions

`tracking_tokens` / `tracking_sessions` (`0006_tracking_tokens.sql`) map cleanly.
Firebase Auth supports anonymous sign-in, so the recipient still gets a real session
and Firestore listeners still work.

Bind the session with a **custom claim carrying its own expiry**, so Rules can check
it without a document read on every snapshot update:

```ts
await getAuth().setCustomUserClaims(uid, {
  track_delivery: deliveryId,
  track_exp: Date.now() + 12 * 3_600_000,
});
```

Rules then check `request.auth.token.track_delivery == deliveryId` and
`request.auth.token.track_exp > request.time.toMillis()`.

**Revocation.** `revoke_token_on_confirmed()` kills the link the moment a delivery
reaches CONFIRMED. A claim cannot be revoked instantly. Solve it in the Rules
predicate instead — allow the read only while the delivery is live:

```
allow read: if request.auth.token.track_delivery == deliveryId
            && request.auth.token.track_exp > request.time.toMillis()
            && resource.data.status != 'CONFIRMED';
```

That gives instant revocation without touching the token, and it is closer to the
intent than the trigger was. `revokeRefreshTokens(uid)` remains the hard backstop.

---

## 4. Blocker 2 — Atomicity

### Correction worth stating up front

Firestore transactions in the **Admin SDK** — what runs inside Cloud Functions —
use **pessimistic** locking. They take locks on the documents they read. So
`FOR UPDATE` at `0004_transition_fn.sql:142-147` maps more closely than it first
appears. The race described in that comment is genuinely covered.

The real problem is different, and sharper.

### 4a. Read-before-write breaks the batch replay

`sync_queue()` (`0004_transition_fn.sql:405-410`) is a loop:

```sql
for v_action in select * from jsonb_array_elements(actions)
loop
  perform delivery_transition(v_action || jsonb_build_object('was_offline', true));
  v_committed := v_committed || (v_action->>'idempotency_key');
end loop;
```

Each iteration **reads state the previous iteration wrote**. A rider's offline
queue is a chain — `ACCEPTED → AT_PICKUP → PICKED_UP → IN_TRANSIT` on one delivery
— and action 2's legality check depends on the status action 1 just set. Postgres
gives that for free: reads inside a transaction see that transaction's own writes.

Firestore forbids it. All reads must precede all writes, and writes are invisible
until commit. The loop breaks at action 2.

### The fix: read-all, simulate, write-all

Hoist the state machine into memory. Four phases inside one transaction:

```ts
export const syncQueue = onCall({ enforceAppCheck: true }, async (request) => {
  const actions = parseActions(request.data?.actions);      // zod, reuse the contract
  const batchId = String(request.data?.batch_id ?? '');
  if (actions.length === 0) return { committed: [], rejected: null };

  // 500 writes per transaction. Each transition writes 1 event + 1 delivery,
  // plus a PIN doc on ARRIVED. Fail loudly rather than truncating silently.
  if (actions.length > 150) {
    throw new HttpsError('invalid-argument', 'BATCH_TOO_LARGE');
  }

  const db = getFirestore();

  return db.runTransaction(async (tx) => {
    // ---- PHASE 1: read everything, once ----------------------------------
    const deliveryIds = [...new Set(actions.map((a) => a.delivery_id))];
    const deliveryRefs = deliveryIds.map((id) => db.collection('deliveries').doc(id));
    const eventRefs = actions
      .map((a) => a.idempotency_key)
      .filter(Boolean)
      .map((k) => db.collection('delivery_events').doc(k!));

    const [actor, deliverySnaps, eventSnaps, rules] = await Promise.all([
      loadActor(tx, db, request.auth),          // profile or tracking binding
      tx.getAll(...deliveryRefs),
      eventRefs.length ? tx.getAll(...eventRefs) : Promise.resolve([]),
      loadTransitionRules(tx, db),              // cache this; it changes ~never
    ]);

    // ---- PHASE 2: simulate in memory -------------------------------------
    const state = new Map(deliverySnaps.map((s) => [s.id, s.data()]));
    const seen  = new Set(eventSnaps.filter((s) => s.exists).map((s) => s.id));
    const writes: PendingWrite[] = [];
    const committed: string[] = [];

    for (const [index, action] of actions.entries()) {
      // Idempotency BEFORE legality — a replayed action has already moved the
      // delivery on, so a legality check first rejects the very replay
      // FR-STM-004 exists to make safe. Same ordering as the plpgsql.
      if (action.idempotency_key && seen.has(action.idempotency_key)) {
        committed.push(action.idempotency_key);
        continue;
      }

      const current = state.get(action.delivery_id);
      const outcome = evaluateTransition(current, action, actor, rules);

      if (!outcome.ok) {
        // FR-STM-011: nothing commits. Throwing rolls back the whole
        // transaction, exactly as the plpgsql exception handler did.
        throw chainConflict(batchId, index, action, current, outcome.code);
      }

      state.set(action.delivery_id, outcome.nextDelivery);   // in-memory only
      writes.push(...outcome.writes);
      if (action.idempotency_key) {
        seen.add(action.idempotency_key);
        committed.push(action.idempotency_key);
      }
    }

    // ---- PHASE 3: write ---------------------------------------------------
    for (const w of writes) applyWrite(tx, db, w);
    for (const [id, d] of state) {
      tx.update(db.collection('deliveries').doc(id), finalFields(d));
    }

    return { committed, rejected: null };
  });
});
```

`evaluateTransition` is the port of the guard ladder at
`0004_transition_fn.sql:106-240`: actor authorisation, idempotency, transition
legality, position and geofence, confirmation tier. It is a **pure function** —
takes state, returns the next state plus a list of writes — which is why the
simulation works and why it is far easier to unit-test than the plpgsql ever was.
That is a genuine gain from the migration.

The single-action `deliveryTransition` function is then a one-element call into the
same machinery. Do not write it twice.

### 4b. Idempotency gets simpler

`delivery_events_idempotency` (`0001_schema.sql:101-103`) is a unique partial index
on `meta->>'idempotency_key'`. Firestore has no unique constraints — but use **the
idempotency key as the event document ID** and uniqueness becomes structural,
enforced by the key space. Cleaner than the index, and it is what the `tx.getAll`
above relies on.

For events with no idempotency key, use an auto-ID.

### 4c. Deferred side effects

`issue_confirmation_pin()` is called mid-transition at
`0004_transition_fn.sql:369-371`. In the simulation it becomes a queued write
emitted in phase 2 and applied in phase 3. Same for the `outbound_sms` document.

### 4d. Contention behaviour changes

Postgres blocks, then proceeds. Firestore retries — roughly five attempts — then
fails. Under contention you get a transient error where you previously got a wait.
Add a retryable error class in `src/lib/contract/errors.ts` and let
`src/lib/sync/sync.ts` treat it as it already treats `retryable` errors: back off
and keep the queue.

### 4e. Limits to guard

| Limit | Value | Impact |
|---|---|---|
| Writes per transaction | 500 | ~150–240 queued actions. Guard at 150. |
| Transaction size | 10 MiB | Not a concern here. |
| Transaction duration | ~270 s | Not a concern; guard the batch size instead. |
| `get()` calls per Rules evaluation | 10 single-doc / 20 query | Why claims beat lookups in §3. |

---

## 5. Blocker 3 — Append-only audit

### What is being replaced

`0002_audit_append_only.sql` uses two independent mechanisms, deliberately — the
header says "because one can be misconfigured":

```sql
create trigger delivery_events_no_update
  before update on delivery_events
  for each row execute function reject_audit_mutation();

revoke update, delete on delivery_events from anon, authenticated, service_role;
```

Note `service_role`. The most privileged credential in the system is denied the
ability to rewrite history. Both `delivery_events` and `proof_artifacts`.

### Why neither mechanism ports

**Grants.** Firestore's only data-authorisation layer is Security Rules, and Rules
apply exclusively to client SDKs. The Admin SDK bypasses them by design. Since
every write in this architecture goes through Cloud Functions using the Admin SDK,
Rules protect nothing here. IAM is per-database, not per-collection, so you cannot
deny delete on `delivery_events` while allowing it on `rider_positions`.

**Triggers.** Firestore triggers fire *after* the write commits. They cannot
reject. You can detect tampering; you cannot prevent it. Compensating by rewriting
the document is itself another mutation, and the original value is already gone.

Left alone, append-only degrades from *the database refuses* to *our code does not
call `.delete()`*. For an evidence log backing delivery disputes, that is a
different product.

### The fix: three layers

#### Layer 1 — Hash chain (tamper evidence, inside Firestore)

Every event carries the hash of its predecessor **for that delivery**:

```ts
// inside phase 2 of the simulation, where prev is already in memory
const canonical = JSON.stringify({
  delivery_id: e.delivery_id,
  from_status: e.from_status,
  to_status:   e.to_status,
  actor_type:  e.actor_type,
  actor_id:    e.actor_id,
  lat: e.lat, lng: e.lng,
  server_time: e.server_time,
  seq: prev.seq + 1,
});
e.prev_hash = prev.hash;
e.hash = createHash('sha256').update(e.prev_hash + canonical).digest('hex');
e.seq  = prev.seq + 1;
```

Chain **per delivery**, not globally — a global chain serialises every write in the
system through one document and will not survive pilot load.

Then a scheduled function walks recent chains and alarms on a break. Editing any
past event now requires rewriting every event after it on that delivery, and still
fails against Layer 2.

The delivery document carries `last_event_hash` and `last_event_seq` so phase 1
reads the chain head without a query.

#### Layer 2 — GCS with a locked retention policy (true immutability)

This is the actual replacement for the revoked grant.

```bash
gsutil mb -l europe-west1 gs://trace-audit-prod
gsutil retention set 7y gs://trace-audit-prod
gsutil retention lock gs://trace-audit-prod    # irreversible — read §5 warning
```

A Firestore trigger streams every event out:

```ts
export const archiveEvent = onDocumentCreated(
  { document: 'delivery_events/{eventId}', retry: true },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    await getStorage()
      .bucket('trace-audit-prod')
      .file(`events/${data.delivery_id}/${String(data.seq).padStart(8, '0')}-${event.params.eventId}.json`)
      .save(JSON.stringify(data), {
        contentType: 'application/json',
        // Fails rather than overwrites if the object already exists, which is
        // what makes the at-least-once trigger safe to re-fire.
        preconditionOpts: { ifGenerationMatch: 0 },
      });
  },
);
```

Once retention is locked, neither you nor Google can delete an object before its
retention period expires. That is stronger than the Postgres grant, which a
superuser could have re-granted.

> **Warning — `retention lock` is irreversible.** A locked policy cannot be
> shortened or removed, and the bucket cannot be deleted until every object's
> retention expires. Set the period deliberately and lock a test bucket first.
> Storage costs accrue for the full period whether or not the pilot continues.

Handle the `ifGenerationMatch: 0` precondition failure as success, not error — it
means the trigger already ran.

#### Layer 3 — Narrowed service accounts and Rules

- **Rules deny all client writes** on `delivery_events` and `proof_artifacts`
  (§8). This does not stop the Admin SDK, but it closes the client path.
- **Split the service accounts.** The Function that writes events gets a role that
  can create documents but not delete them, via a custom IAM role on the Firestore
  API. This is coarser than the Postgres grant, but it is not nothing.
- **Enable Data Access audit logs** for Firestore so a delete is at least recorded
  in Cloud Audit Logs, outside the database that was mutated.

### Residual risk, stated plainly

An engineer with deploy access to Cloud Functions can still delete a Firestore
event document. What they cannot do is remove it from GCS or repair the hash chain
across the archive. Detection is guaranteed; prevention is not. Postgres gave you
both. Record this as an accepted loss in §14 and tell whoever signs off on the
concept-note claims.

---

## 6. Blocker 4 — Blaze plan

Not merely an egress constraint. Cloud Functions cannot be deployed on the Spark
plan at all, and this architecture cannot run without them — Security Rules cannot
express the guard ladder at `0004_transition_fn.sql:106-240` (org membership, rider
assignment, open-shift check, transition-rule lookup, geofence distance). Blaze is
a hard prerequisite.

### Actions

1. Enable Blaze on the project.
2. Set a GCP budget with alerts at 50%, 90%, 100%.
3. **Add a kill switch.** Budget alerts notify; they do not stop spending. Wire the
   budget to a Pub/Sub topic and a function that disables billing at threshold.
   A function that writes a document which triggers the same function is a
   recursion that bills in real time — the `archiveEvent` trigger above must never
   write into `delivery_events`.
4. Set `maxInstances` on every function. The default is high enough to be
   expensive under a runaway client retry loop.
5. Reword `docs/superpowers/specs/2026-08-19-trace-design.md:365`. The claim that
   the system "operates within the free tiers" needs to become "operates within
   free-tier quotas on a billable account." The quotas are still free; the account
   is not free-standing.

Actual pilot cost will be close to zero. The friction is the card and the absence
of a hard cap.

---

## 7. Data model translation

| Postgres | Firestore | Notes |
|---|---|---|
| `organisations` | `organisations/{id}` | `settings` map carries the health thresholds. |
| `profiles` | `profiles/{uid}` | Doc ID is the Firebase Auth uid. Mirror `role`/`org` into custom claims. |
| `shifts` | `shifts/{id}` | The partial unique index "one open shift per rider" has no Firestore equivalent — enforce in the Function, and store `open_shift_id` on the profile doc. |
| `deliveries` | `deliveries/{id}` | Add `last_event_hash`, `last_event_seq`. |
| `delivery_events` | `delivery_events/{idempotencyKey}` | Doc ID gives idempotency for free. |
| `rider_positions` | `rider_positions/{riderId}` | One doc per rider, upserted. Same shape as today. |
| `position_history` | `deliveries/{id}/breadcrumbs/{id}` | Subcollection — always read per delivery. |
| `confirmation_pins` | `confirmation_pins/{deliveryId}` | Never client-readable. |
| `proof_artifacts` | `proof_artifacts/{id}` | Blobs in Cloud Storage; metadata here. |
| `tracking_tokens` | `tracking_tokens/{sha256}` | Doc ID is the token hash — lookup by hash is a `get`, not a query. |
| `tracking_sessions` | custom claims | See §3. |
| `sap_sync_queue` | `sap_sync_queue/{id}` | Drained by a scheduled function. |
| `geocode_cache` | `geocode_cache/{key}` | Server-only. |
| `outbound_sms` | `outbound_sms/{id}` | Drained by a trigger, not a cron. See below. |
| `transition_rules` | `transition_rules/{from_to}` | Load once per function instance and cache. |
| **`deliveries_with_health`** | **nothing** | See below. |

### The health view disappears, and that is good

`deliveries_with_health` (`0007_delivery_health.sql`) computes amber/red from
`now()`, `eta_at`, and the org's thresholds. There is no Firestore view, and no
Firestore query can express it.

But the computation is trivial and depends on the clock, so **compute it on the
client** from `eta_at` and the org settings document. One shared function in
`src/lib/dashboard/health.ts`, used by the dashboard, the wallboard, and the detail
page — which preserves the property the view header cares about ("there is one
definition of late and it lives here").

This also removes a class of staleness bug, because a client recomputes on every
render rather than on every server read.

`delivery_health_summary()` becomes a client-side reduce over the same live
snapshot the wallboard already holds. One less round trip, not one more.

### Scheduled work

| pg_cron job | Firebase replacement |
|---|---|
| `purge-outbound-sms` (hourly) | Scheduled function — this **redacts** the body rather than deleting the row, so TTL is wrong for it. |
| `purge-tracking-sessions` (daily) | Mostly unnecessary: claims expire by their own `track_exp`. Keep a weekly sweep of anonymous Auth users. |
| — | **Firestore TTL policy** on `otp_requests.expires_at` and `otp_ip_budget` — free deletion, no function needed. |

### The SMS worker gets simpler

`sms-worker/index.ts` polls `outbound_sms` on a cron with a manual attempt counter.
Replace it with `onDocumentCreated('outbound_sms/{id}', { retry: true })`, which
gives at-least-once delivery with exponential backoff from the platform. Keep a
scheduled sweep for stragglers, but the retry loop is no longer yours.

Keep the discipline from the current worker: overwrite `body` in the same write
that sets `sent_at`, so there is no window where a sent code is still readable.

---

## 8. Security Rules — replacing RLS

RLS has 240 lines and does subqueries. Rules cannot, cheaply. The translation
strategy is: **push identity into claims, deny all writes, allow narrow reads.**

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn()   { return request.auth != null; }
    function org()        { return request.auth.token.org; }
    function role()       { return request.auth.token.role; }
    function isAdmin()    { return role() in ['sub_admin', 'super_admin']; }
    function tracking(id) {
      return request.auth.token.track_delivery == id
          && request.auth.token.track_exp > request.time.toMillis();
    }

    // CON-002. No client writes a business document, ever. Every write in this
    // system goes through a callable Function running the guard ladder.
    match /{document=**} {
      allow write: if false;
    }

    match /profiles/{uid} {
      allow read: if signedIn() && (uid == request.auth.uid
                  || (isAdmin() && resource.data.org_id == org()));
    }

    match /deliveries/{id} {
      allow read: if signedIn() && (
           resource.data.assigned_rider_id == request.auth.uid
        || (resource.data.assigned_rider_id == null
            && resource.data.status == 'CREATED'
            && resource.data.org_id == org())
        || (isAdmin() && resource.data.org_id == org())
        // Recipient: live only. Instant revocation at CONFIRMED without
        // touching the token — replaces revoke_token_on_confirmed().
        || (tracking(id) && resource.data.status != 'CONFIRMED')
      );
    }

    match /delivery_events/{eventId} {
      allow read: if signedIn() && (
           isAdmin() && resource.data.org_id == org()
        || resource.data.rider_id == request.auth.uid
        || tracking(resource.data.delivery_id)
      );
    }

    match /rider_positions/{riderId} {
      allow read: if signedIn() && (
           riderId == request.auth.uid
        || (isAdmin() && resource.data.org_id == org())
        || (tracking(resource.data.active_delivery_id)
            && resource.data.status_live == true)
      );
    }

    // Never client-readable, under any identity. Mirrors the
    // "DELIBERATELY NOT GRANTED" block in 0008_grants.sql.
    match /confirmation_pins/{id}  { allow read: if false; }
    match /outbound_sms/{id}       { allow read: if false; }
    match /geocode_cache/{id}      { allow read: if false; }
    match /tracking_tokens/{id}    { allow read: if false; }
  }
}
```

### Denormalisation this forces

Rules cannot join, so fields the policies need must be **on the document being
read**:

- `delivery_events` needs `org_id` and `rider_id` copied onto each event.
- `rider_positions` needs `org_id`, `active_delivery_id`, and a `status_live`
  boolean replacing the `status in (ACCEPTED..ARRIVED)` subquery in
  `positions_recipient_read`.

These are written by the same Function that writes the document, so they cannot
drift — but they must be in the write path from day one, not retrofitted.

### The failure mode RLS did not have

A missing Rules `match` block denies access — same as RLS. But a **too-broad**
`allow read` is silent, and there is no equivalent of the `security_invoker` trap
the view header warns about, because there are no views. The compensating control
is the emulator test suite in §11. Treat it as mandatory, not optional.

---

## 9. Realtime

Every `postgres_changes` channel maps to `onSnapshot`. Nine call sites:

| Current | Firestore |
|---|---|
| `dashboard/page.tsx:55` | `onSnapshot` on the active-deliveries query |
| `dashboard/[id]/page.tsx:85` | `onSnapshot` on `deliveries/{id}` + its events subquery |
| `rider/page.tsx:54` | `onSnapshot` on the rider's inbox query |
| `t/[token]/TrackingView.tsx:122` | two listeners: delivery, and rider position |
| `wall/page.tsx:49` | `onSnapshot` on the active-deliveries query |
| `hooks/useRiderDelivery.ts:72` | `onSnapshot` on `deliveries/{id}` |

Two improvements come free: Firestore delivers the changed document rather than a
change notification you then re-query on (all six sites currently call `load()`
again), and listeners survive reconnection without manual resubscription.

One regression: Firestore charges per document read, including snapshot updates.
The wallboard holding a live listener on every active delivery is the one to watch.
At pilot volume it is negligible; model it before scaling.

---

## 10. Code inventory

### Untouched — the majority of the app

```
src/lib/contract/**        zod schemas, error codes, status vocabulary
src/lib/geo/**             geofence maths, position tracker
src/lib/queue/**           IndexedDB offline queue
src/lib/map/**             Google Maps adapter
src/components/**          every React component
src/hooks/useSyncStatus.ts
src/app/**/page.tsx        layout and markup (data-fetching lines change)
```

The contract layer surviving intact is the reason this migration is bounded. It was
designed as the boundary and it holds.

### Rewritten

| File | Becomes |
|---|---|
| `src/lib/supabase/client.ts` | `src/lib/firebase/client.ts` |
| `src/lib/supabase/server.ts` | `src/lib/firebase/server.ts` (Admin SDK, server components) |
| `src/lib/supabase/rpc.ts` | `src/lib/firebase/callable.ts` — same exported signatures |
| `src/middleware.ts` | Session cookie via `createSessionCookie()`; same redirect logic |
| `src/lib/dashboard/queries.ts` | Firestore queries + client-side health |
| `src/lib/tracking/token.ts` | Callable instead of RPC |
| `src/app/rider/login/page.tsx` | `requestOtp` / `verifyOtp` callables |
| `src/app/login/page.tsx` | Same |
| 9 × Realtime call sites | `onSnapshot` |

`replayBatch()` and `requestTransition()` in `rpc.ts` should keep their exact
signatures. If they do, `src/lib/sync/sync.ts` and `src/lib/rider/actions.ts` — the
offline path — need no changes at all.

### New

```
functions/src/auth/requestOtp.ts, verifyOtp.ts, hash.ts
functions/src/delivery/evaluateTransition.ts   ← the ported guard ladder
functions/src/delivery/transition.ts, syncQueue.ts, create.ts
functions/src/confirmation/issuePin.ts, verifyPin.ts, resendPin.ts
functions/src/tracking/issueToken.ts, claimToken.ts, tokenState.ts
functions/src/sms/provider.ts                  ← port africastalking.ts
functions/src/sms/onOutbound.ts                ← replaces sms-worker
functions/src/audit/archiveEvent.ts, verifyChain.ts
functions/src/scheduled/purgeOutboundSms.ts
firestore.rules
firestore.indexes.json
```

### Deleted

All nine migrations, `apply_all.sql`, `config.toml`, both Edge Functions. Keep
`supabase/tests/security.test.sql` as the specification for §11 — do not delete it
until every test has an emulator equivalent that passes.

---

## 11. Test strategy — the acceptance gate

`supabase/tests/security.test.sql` opens with:

> "Every test here corresponds to a claim made to the evaluation panel. If one
> fails, a sentence in the concept note has become untrue."

That sentence is the migration's acceptance criterion. **The migration is done when
every one of these passes against the Firebase emulator suite — not when the app
renders.**

Port each to `functions/test/` using `@firebase/rules-unit-testing` plus the
Firestore and Auth emulators:

| # | Claim | Where it lives now |
|---|---|---|
| 1, 2 | Geofence rejects/permits by distance | `evaluateTransition` unit test |
| 3 | Tier 3 stops at DELIVERED | `evaluateTransition` unit test |
| 4 | Idempotent replay adds no audit row | Function integration test |
| 5 | Rider cannot touch another's delivery | Function + Rules test |
| 6 | A `sender` is not an admin | `evaluateTransition` unit test |
| 7 | Illegal transitions refused server-side | `evaluateTransition` unit test |
| 8 | Rider cannot claim the recipient's tier | `evaluateTransition` unit test |
| 9 | **Status is never client-writable** | **Rules test — the load-bearing one** |
| 10, 11 | Audit log append-only | Rules test + hash-chain verifier test |
| 12 | Proof artefacts are evidence too | Rules test |
| 13 | Off shift erases live position | Function integration test |
| 14 | Moving the geofence is audited | Function integration test |
| 16 | Rider cannot create a delivery | Rules + Function test |

Add three that Postgres made unnecessary and Firestore makes essential:

17. **Batch chain replay** — a 4-action chain on one delivery commits in order.
    This is the read-before-write fix in §4a and it has no Postgres equivalent
    because Postgres never had the problem.
18. **Batch all-or-nothing** — a failure at index 3 leaves indices 0–2 uncommitted.
19. **Hash chain integrity** — tampering with event *n* is detected by the verifier.

Wire `npm run verify` to run the emulator suite. The current script chains
typecheck, lint, and vitest; add `firebase emulators:exec`.

---

## 12. Phase plan

Each phase ends in a checkpoint you can fail on. Do not start the next phase until
the current one passes.

### Phase 0 — Foundations (no app changes)

- Create the Firebase project. Enable Blaze, budget, kill switch (§6).
- Create the GCS audit bucket. **Lock retention on a throwaway bucket first.**
- Stand up the emulator suite in CI.
- Port `supabase/tests/security.test.sql` to skipped, failing emulator tests.

**Checkpoint:** every ported test exists and fails for the right reason.

### Phase 1 — Data model and Rules

- Write `firestore.rules` (§8) and `firestore.indexes.json`.
- Write the Postgres → Firestore export script (read-only against production).
- Run it against a snapshot into the emulator.

**Checkpoint:** Rules tests 9, 10, 11, 12, 16 pass. Nothing else is built yet, and
these are the tests that protect the claims that matter most.

### Phase 2 — The transition engine

- Port the guard ladder to `evaluateTransition` as a pure function.
- Wrap it in `deliveryTransition` (single) and `syncQueue` (batch, §4a).
- Add the hash chain (§5, layer 1).

**Checkpoint:** tests 1–8, 13, 14, 17, 18, 19 pass.

### Phase 3 — Auth

- `requestOtp` / `verifyOtp`, App Check, custom claims (§3).
- Port the Africa's Talking adapter to `functions/src/sms/`.
- Anonymous recipient sessions and the claim-based tracking binding.

**Checkpoint:** a real handset receives a code from Africa's Talking and signs in;
rate limits and lockout demonstrably fire; a wrong code and an unregistered number
return identical errors.

### Phase 4 — Client rewiring

- `src/lib/firebase/*` replacing `src/lib/supabase/*`, same exported signatures.
- Nine Realtime call sites to `onSnapshot`.
- Health computation moves client-side.
- Middleware to session cookies.

**Checkpoint:** `npm run verify` passes; the rider flow works end to end against
the emulator, **offline included** — that is the path most likely to regress.

### Phase 5 — Audit archival

- `archiveEvent` trigger to GCS (§5, layer 2).
- Scheduled `verifyChain`.
- Narrowed service accounts, Data Access audit logs.

**Checkpoint:** an event written in the app appears in GCS within seconds; a
manually corrupted event is flagged by the verifier on its next run.

### Phase 6 — Parallel run

- Deploy Firebase alongside Supabase. Both live, Supabase authoritative.
- Mirror production writes into Firebase; compare state daily.

**Checkpoint:** one full week, zero divergence.

### Phase 7 — Cutover (§13).

### Phase 8 — Decommission

Only after 30 days of clean production operation. Export the Postgres database and
keep it — it is the only complete copy of the pre-migration audit log.

---

## 13. Cutover and rollback

### Cutover

1. Announce a maintenance window. Riders must have empty offline queues before it
   starts — the queue is device-local and does not migrate. Check `queueStats()`
   telemetry, and do not start until it is zero.
2. Set Supabase to read-only (revoke execute on `delivery_transition` and
   `sync_queue`).
3. Run the final export/import delta.
4. Verify counts and spot-check the newest 100 events on both sides.
5. Flip the client build.
6. Watch for one hour before standing down.

### Rollback

Rollback is viable **only during Phase 6 and the first hours after cutover**, and
only if no writes have landed in Firebase that are not also in Postgres. Once real
deliveries have been transitioned in Firebase, rolling back means reverse-migrating
the audit log, which is exactly the operation the whole design exists to make
difficult.

Decide the rollback deadline before cutover and write it down. After that point the
only way is forward.

### The offline queue is the sharpest edge

A rider whose phone is in a basement during cutover comes back online holding
actions signed for the old backend. They will fail. `sync.ts` retains them and
surfaces the failure (FR-OFF-007), so nothing is lost silently — but someone has to
replay them by hand. Budget for it.

---

## 14. Accepted losses — sign these off explicitly

Print this section. Have whoever owns the concept-note claims initial it.

1. **The audit log is no longer immutable by database grant.** It is immutable in
   GCS, tamper-evident by hash chain, and mutable in Firestore by anyone with
   deploy access to Cloud Functions. Detection is guaranteed; prevention is not.
   (§5)

2. **`service_role` no longer excluded from mutating history.** The Admin SDK holds
   full access by design. `0002_audit_append_only.sql` specifically closed this;
   Firestore cannot.

3. **Authorisation logic splits in two.** Reads are governed by Security Rules,
   writes by TypeScript in Cloud Functions. Today both live in SQL beside the data.
   Two places to keep in agreement is a permanent maintenance cost.

4. **OTP security becomes yours.** Generation, hashing, expiry, lockout, and both
   rate-limit axes are now your code on a money-spending endpoint. (§3)

5. **Role changes are not instant for reads.** Custom claims propagate on token
   refresh, up to an hour, unless forced. RLS re-evaluated on every statement.

6. **Denormalised fields can drift.** `org_id` and `rider_id` on events,
   `status_live` on positions — all things a join computed correctly by
   construction. A bug in one Function now produces documents that Rules
   mis-authorise.

7. **The free-tier claim needs rewording.** (§6)

Against these, you gain: a testable pure-function state machine, simpler
idempotency, platform-managed SMS retry, free TTL deletion, better realtime
semantics, and — if you go with GCS retention lock — an audit archive that is
genuinely harder to tamper with than the Postgres original.

Whether that trade is worth roughly six to eight weeks of work is the question §1
asks. This document does not answer it.
