# Shipping TRACE to production

**Last updated:** 20 August 2026
**Target:** Vercel (application) + Supabase (database, auth) + Google Maps Platform

---

## 1. What ships, and what does not

### Working end to end

| Surface | Route | State |
|---|---|---|
| Rider PWA | `/rider`, `/rider/login`, `/rider/delivery/[id]` | Offline queue, sync replay, geofence, shift handling |
| Customer tracking | `/t/[token]` | Live map, Tier 1 confirmation, closed-link screen |
| Dispatch dashboard | `/dashboard`, `/dashboard/new`, `/dashboard/[id]` | Create, assign, tracking links, audit trail |
| Wallboard | `/wall` | Exception-first, live |
| Database | 9 migrations | State machine, RLS, append-only audit, PIN, tracking sessions |
| Tests | 21 pgTAP + 29 Vitest | All passing |

### Not built — read this before promising a date

| Gap | Consequence |
|---|---|
| **SMS worker Edge Function** | `outbound_sms` rows accumulate and nothing sends them. **Tier 2 confirmation does not reach the recipient.** |
| **Supabase Auth SMS provider** | Phone OTP login does not work at all until an SMS provider is configured in the Supabase dashboard. This blocks every login. |
| **SAP ByDesign adapter** | No import, no write-back. §08 of the concept note declares this honestly as mock-backed; the mock is also not written yet. |
| **Server-side geocoding** | `destination_lat/lng` are never populated, so **`DELIVERED` cannot pass the geofence check** — `DESTINATION_NOT_GEOCODED` is raised. Deliveries can be created and carried but not closed. |
| **Web Push** | Riders are not notified of new assignments; they see them on next open. |

**The geocoding gap is the one that stops a demo.** Until addresses are geocoded, no delivery can be completed. Either build the geocoding step, or seed `destination_lat/lng` directly for demo records.

---

## 2. Prerequisites

Blocking. Nothing below works until these are done.

1. **Rotate the Supabase secret key.** `sb_secret_…` was pasted into a chat transcript on 19 August. Project Settings → API Keys → rotate.
2. **Enable anonymous sign-in.** Authentication → Providers → Anonymous sign-ins. The customer tracking page cannot bind a session without it.
3. **Restrict the Google Maps browser key.** Google Cloud Console → Credentials:
   - Application restrictions: HTTP referrers → your Vercel domain and `http://localhost:3000/*`
   - API restrictions: Maps JavaScript API only
4. **Create a second Maps key for the server**, restricted to Geocoding and Routes, no referrer restriction. Never give it a `NEXT_PUBLIC_` prefix.
5. **Configure an SMS provider** in Supabase → Authentication → Providers → Phone. Twilio works natively. Africa's Talking requires the Send SMS auth hook pointed at an Edge Function, which is not yet written.

---

## 3. Apply the schema

The migrations have been validated against a local Postgres. Apply them once, in order.

**Option A — CLI, if you have the database password:**

```bash
cd trace
npx supabase link --project-ref icxisfwxrcwkwvqvgqgl
npx supabase db push
```

**Option B — SQL editor:** paste `trace/supabase/apply_all.sql` and run once, top to bottom.

Then seed the first organisation and administrator by hand — there is no bootstrap UI, deliberately, because creating the first super-admin is not something an anonymous caller should be able to do:

```sql
insert into organisations (id, name) values (gen_random_uuid(), 'Your Organisation');

-- Sign in once via /login so auth.users has your row, then:
insert into profiles (id, org_id, role, full_name, phone)
select '<your-auth-user-id>', id, 'super_admin', 'Your Name', '+2567XXXXXXXX'
  from organisations limit 1;
```

Verify:

```sql
select count(*) from transition_rules;   -- expect 19
select count(*) from pg_policies where schemaname = 'public';
```

---

## 4. Deploy to Vercel

```bash
cd trace
npx vercel
```

Set the root directory to `trace` when prompted — the repository root holds documentation, not the application.

### Environment variables

Set these in Vercel → Settings → Environment Variables, for Production and Preview:

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://icxisfwxrcwkwvqvgqgl.supabase.co` | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_…` | Publishable key only |
| `NEXT_PUBLIC_GOOGLE_MAPS_KEY` | Browser key | Referrer-restricted |
| `GOOGLE_MAPS_SERVER_KEY` | Server key | No `NEXT_PUBLIC_` prefix |

**Never set:** `NEXT_PUBLIC_TRACE_FIXTURES` (renders seeded demo data instead of your database), or any `sb_secret_…` value. The application has no service-role client and does not need one.

### After the first deploy

Add the Vercel domain to:
- Google Maps browser key referrer restrictions
- Supabase → Authentication → URL Configuration → Site URL and Redirect URLs

---

## 5. Verify in production

Work down this list. Each line corresponds to a claim in the concept note.

- [ ] `/login` sends an OTP and signs in — *requires an SMS provider*
- [ ] `/dashboard` lists deliveries and updates without a refresh
- [ ] `/dashboard/new` creates a delivery and assigns a `TRC-…` reference
- [ ] Assigning a rider writes an `ASSIGNED` row in the audit trail
- [ ] `/wall` shows the quiet state, then an exception when a delivery goes late
- [ ] A tracking link opens `/t/<token>` with no account
- [ ] The recipient sees the rider move on the map
- [ ] ✓ Received transitions the delivery to `CONFIRMED` — *requires geocoded coordinates*
- [ ] Reopening a spent link shows "Delivery confirmed", not an error
- [ ] Airplane mode on the rider device queues actions and drains on reconnect

Run the security suite against staging before every release:

```bash
cd trace
npx supabase start
npx supabase test db
```

21 tests. Each maps to a sentence in the concept note; a failure means one of those sentences has stopped being true.

---

## 6. Operational notes

**Cost.** Supabase and Vercel free tiers cover pilot volume. SMS does not: budget roughly **US$10–20/month at 1,000 deliveries** on Africa's Talking rates. §12 of the concept note needs the qualifier *"excluding SMS, which is metered at approximately US$0.01 per delivery"*.

**Scheduled jobs** are registered by migration 0006 via `pg_cron`:
- `purge-outbound-sms` — hourly, clears PIN plaintext
- `purge-tracking-sessions` — nightly, sweeps expired anonymous users

Confirm both after deploying: `select * from cron.job;`

**Honest limitation to state to the panel:** GPS position is client-asserted. The server validates the claim against the geofence and records accuracy and the OS mock-location flag, but no server can cryptographically prove a device's location. Geofencing raises falsification from trivial to deliberate. §18's phrase "makes falsified delivery impossible" overstates it and should be softened.
