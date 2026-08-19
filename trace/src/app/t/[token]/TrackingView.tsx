'use client';

/**
 * Live tracking for the recipient. SRS §5.3.2, FR-CNF-001.
 *
 * The scoped JWT is passed from the server and used for both PostgREST and
 * Realtime, so RLS — not this component — decides what is visible. If a policy
 * is wrong, this screen goes blank rather than leaking; that is the intended
 * failure direction.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

interface Delivery {
  id: string;
  trace_id: string;
  status: string;
  recipient_name: string | null;
  destination_address: string | null;
  eta_at: string | null;
}

interface RiderPosition {
  lat: number;
  lng: number;
  updated_at: string;
}

/** Plain language, because the recipient is not reading a state machine. */
const STATUS_COPY: Record<string, string> = {
  CREATED: 'Your delivery is being prepared',
  ASSIGNED: 'A rider has been assigned',
  ACCEPTED: 'Your rider is on the way to collect it',
  AT_PICKUP: 'Your rider is collecting your delivery',
  PICKED_UP: 'Collected — setting off now',
  IN_TRANSIT: 'On the way to you',
  ARRIVED: 'Your rider has arrived',
  DELIVERED: 'Delivered — thank you',
  CONFIRMED: 'Delivery confirmed',
  FAILED: 'This delivery could not be completed',
  RETURNED: 'This delivery is being returned',
};

export function TrackingView({
  deliveryId,
  jwt,
  expiresAt,
}: {
  deliveryId: string;
  jwt: string;
  expiresAt: number;
}) {
  const supabase = useMemo(
    () =>
      createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          auth: { persistSession: false, autoRefreshToken: false },
          // Both PostgREST and Realtime read the scoped token from here.
          accessToken: async () => jwt,
        },
      ),
    [jwt],
  );

  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [position, setPosition] = useState<RiderPosition | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  // The grant is short-lived and cannot be revoked once minted, so the page
  // stops itself rather than sitting on a stale view of a live delivery.
  useEffect(() => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('deliveries')
      .select('id, trace_id, status, recipient_name, destination_address, eta_at')
      .eq('id', deliveryId)
      .maybeSingle();
    if (data) setDelivery(data as Delivery);
  }, [supabase, deliveryId]);

  useEffect(() => {
    void load();

    const channel = supabase
      .channel(`track:${deliveryId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'deliveries', filter: `id=eq.${deliveryId}` },
        () => void load(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rider_positions' },
        (payload) => {
          const row = payload.new as Partial<RiderPosition> | null;
          // RLS already limits this to the rider on this delivery, and only
          // while the delivery is in a state the recipient may watch.
          if (row?.lat != null && row?.lng != null) {
            setPosition({
              lat: Number(row.lat),
              lng: Number(row.lng),
              updated_at: String(row.updated_at ?? ''),
            });
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, deliveryId, load]);

  const confirmReceipt = useCallback(async () => {
    setConfirming(true);
    setError(null);

    const { error: rpcError } = await supabase.rpc('delivery_transition', {
      payload: {
        delivery_id: deliveryId,
        to_status: 'DELIVERED',
        // Idempotent: a double tap on a slow connection is one confirmation.
        idempotency_key: crypto.randomUUID(),
        device_time: new Date().toISOString(),
        confirmation: { method: 'recipient_tap' },
      },
    });

    if (rpcError) {
      setError(
        rpcError.message.includes('OUTSIDE_GEOFENCE')
          ? 'Your rider does not appear to be at the delivery address yet.'
          : rpcError.message.includes('POSITION_REQUIRED')
            ? 'We cannot see your rider’s location right now. Please try again shortly.'
            : 'That did not go through. Please try again.',
      );
      setConfirming(false);
      return;
    }

    await load();
    setConfirming(false);
  }, [supabase, deliveryId, load]);

  if (expired) {
    return (
      <Shell>
        <p className="text-center text-mist-400">
          This view has timed out. Reopen the link from your message to continue.
        </p>
      </Shell>
    );
  }

  if (!delivery) {
    return (
      <Shell>
        <p className="text-center text-mist-400">Loading your delivery…</p>
      </Shell>
    );
  }

  const eta = delivery.eta_at
    ? new Date(delivery.eta_at).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  const canConfirm = delivery.status === 'ARRIVED';
  const done = delivery.status === 'DELIVERED' || delivery.status === 'CONFIRMED';

  return (
    <Shell>
      <p className="wrap-hard text-sm tracking-wide text-mist-400">{delivery.trace_id}</p>

      <h1 className="mt-2 text-2xl font-semibold text-mist-100">
        {STATUS_COPY[delivery.status] ?? delivery.status}
      </h1>

      {eta && !done && (
        <p className="mt-2 text-mist-200">
          Arriving around <span className="font-semibold text-mist-100">{eta}</span>
        </p>
      )}

      {delivery.destination_address && (
        <p className="wrap-hard mt-6 text-sm text-mist-400">
          {delivery.destination_address}
        </p>
      )}

      {position && !done && (
        <p className="mt-6 rounded-xl bg-ink-800 px-4 py-3 text-sm text-mist-200">
          Rider position updating live
        </p>
      )}

      {error && (
        <p role="alert" className="mt-6 rounded-xl bg-ink-800 px-4 py-3 text-stop-500">
          {error}
        </p>
      )}

      {canConfirm && (
        <button
          type="button"
          onClick={() => void confirmReceipt()}
          disabled={confirming}
          className="mt-8 min-h-tap w-full rounded-2xl bg-go-600 px-6 text-lg font-semibold text-ink-900 disabled:opacity-60"
        >
          {confirming ? 'Confirming…' : '✓ Received'}
        </button>
      )}

      {done && (
        <p className="mt-8 rounded-2xl bg-go-700 px-6 py-4 text-center font-semibold text-ink-900">
          Thank you — receipt recorded
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      {children}
    </main>
  );
}
