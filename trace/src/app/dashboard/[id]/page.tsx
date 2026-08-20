'use client';

/**
 * One delivery. SRS §5.1.1.
 *
 * Three things a dispatcher does here: give it to a rider, send the recipient
 * their link, and read what actually happened. The audit trail is the page's
 * spine rather than a tab, because "what happened" is the product.
 */
import { use, useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { DeliveryMap } from '@/components/map/DeliveryMap';

interface Delivery {
  id: string;
  trace_id: string;
  status: string;
  recipient_name: string | null;
  recipient_phone: string | null;
  destination_address: string | null;
  destination_lat: number | null;
  destination_lng: number | null;
  geofence_radius_m: number | null;
  assigned_rider_id: string | null;
  confirmation_tier: number | null;
  eta_at: string | null;
}

interface EventRow {
  id: number;
  from_status: string | null;
  to_status: string;
  actor_type: string;
  device_time: string | null;
  server_time: string;
  was_offline: boolean;
  meta: Record<string, unknown>;
}

interface Rider {
  id: string;
  full_name: string;
}

const TIER_LABEL: Record<number, string> = {
  1: 'Tier 1 — recipient tapped Received',
  2: 'Tier 2 — code read aloud',
  3: 'Tier 3 — signature or photo, unconfirmed by recipient',
};

export default function DeliveryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [chosenRider, setChosenRider] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: d }, { data: e }, { data: r }] = await Promise.all([
      supabase().from('deliveries').select('*').eq('id', id).maybeSingle(),
      supabase()
        .from('delivery_events')
        .select('id, from_status, to_status, actor_type, device_time, server_time, was_offline, meta')
        .eq('delivery_id', id)
        .order('id', { ascending: false }),
      supabase().from('profiles').select('id, full_name').eq('role', 'rider'),
    ]);

    if (d) setDelivery(d as Delivery);
    setEvents((e ?? []) as EventRow[]);
    setRiders((r ?? []) as Rider[]);
  }, [id]);

  useEffect(() => {
    void load();

    const channel = supabase()
      .channel(`delivery:${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'delivery_events', filter: `delivery_id=eq.${id}` },
        () => void load(),
      )
      .subscribe();

    return () => {
      void supabase().removeChannel(channel);
    };
  }, [id, load]);

  async function assign() {
    if (!chosenRider) return;
    setBusy(true);
    setProblem(null);
    const { error } = await supabase().rpc('assign_delivery', {
      p_delivery: id,
      p_rider: chosenRider,
    });
    setBusy(false);
    if (error) {
      setProblem('Could not assign that rider.');
      return;
    }
    await load();
  }

  async function issueLink() {
    setBusy(true);
    setProblem(null);
    const { data, error } = await supabase().rpc('issue_tracking_token', {
      p_delivery: id,
    });
    setBusy(false);
    if (error || !data) {
      setProblem('Could not create a tracking link.');
      return;
    }
    // Shown once. The token is stored only as a hash, so it cannot be recovered
    // afterwards — issuing again produces a new link and revokes this one.
    setLink(`${window.location.origin}/t/${data as string}`);
  }

  if (!delivery) return <p className="text-mist-400">Loading…</p>;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="wrap-hard text-xs uppercase tracking-[0.25em] text-mist-400">
            {delivery.trace_id}
          </p>
          <h1 className="wrap-hard mt-1 text-2xl font-semibold text-mist-100">
            {delivery.recipient_name ?? 'Recipient not named'}
          </h1>
          <p className="wrap-hard text-mist-400">{delivery.destination_address}</p>
        </div>
        <span className="rounded-full bg-ink-800 px-4 py-2 text-sm text-mist-200">
          {delivery.status}
        </span>
      </header>

      {delivery.confirmation_tier && (
        <p className="rounded-xl bg-ink-800 px-4 py-3 text-sm text-mist-200">
          {TIER_LABEL[delivery.confirmation_tier]}
        </p>
      )}

      {problem && (
        <p role="alert" className="rounded-xl bg-ink-800 px-4 py-3 text-stop-500">
          {problem}
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-sm uppercase tracking-[0.2em] text-mist-400">Rider</h2>
          <select
            value={chosenRider}
            onChange={(e) => setChosenRider(e.target.value)}
            className="min-h-tap w-full rounded-xl border border-ink-500 bg-ink-800 px-4 text-mist-100"
          >
            <option value="">Choose a rider…</option>
            {riders.map((rider) => (
              <option key={rider.id} value={rider.id}>
                {rider.full_name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!chosenRider || busy}
            onClick={() => void assign()}
            className="min-h-tap w-full rounded-xl bg-go-600 font-semibold text-ink-900 disabled:opacity-50"
          >
            {delivery.assigned_rider_id ? 'Reassign' : 'Assign'}
          </button>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm uppercase tracking-[0.2em] text-mist-400">
            Recipient link
          </h2>
          {link ? (
            <p className="wrap-hard rounded-xl bg-ink-800 px-4 py-3 text-sm text-go-500">
              {link}
            </p>
          ) : (
            <p className="text-sm text-mist-400">
              Shown once when created. It is stored as a hash and cannot be read back.
            </p>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void issueLink()}
            className="min-h-tap w-full rounded-xl border border-ink-500 font-semibold text-mist-100 disabled:opacity-50"
          >
            {link ? 'Issue a new link' : 'Create tracking link'}
          </button>
        </section>
      </div>

      {delivery.destination_lat != null && (
        <DeliveryMap
          className="h-72"
          destination={{
            lat: Number(delivery.destination_lat),
            lng: Number(delivery.destination_lng),
          }}
          rider={null}
          geofenceRadiusM={delivery.geofence_radius_m ?? undefined}
        />
      )}

      <section>
        <h2 className="text-sm uppercase tracking-[0.2em] text-mist-400">
          What happened
        </h2>
        <ol className="mt-4 space-y-2">
          {events.map((event) => (
            <li
              key={event.id}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xl bg-ink-800 px-4 py-3"
            >
              <span className="font-medium text-mist-100">
                {event.from_status ? `${event.from_status} → ` : ''}
                {event.to_status}
              </span>
              <span className="text-sm text-mist-400">{event.actor_type}</span>
              <span className="flex-1 text-right text-sm tabular-nums text-mist-400">
                {new Date(event.server_time).toLocaleString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              {event.was_offline && (
                // FR-STM-013: the offline period is visible in the proof record
                // rather than concealed by it.
                <span className="rounded-full bg-info-500/15 px-3 py-1 text-xs text-info-500">
                  synced offline
                </span>
              )}
              {Array.isArray(event.meta?.anomalies) &&
                (event.meta.anomalies as string[]).map((flag) => (
                  <span
                    key={flag}
                    className="rounded-full bg-warn-500/15 px-3 py-1 text-xs text-warn-500"
                  >
                    {flag.replace(/_/g, ' ')}
                  </span>
                ))}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
