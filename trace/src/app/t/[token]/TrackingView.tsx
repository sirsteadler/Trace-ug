'use client';

/**
 * Live tracking for the recipient. SRS §5.3.2, FR-CNF-001.
 *
 * Sign in anonymously, exchange the link token for a session binding, then read
 * one delivery over Realtime. RLS — not this component — decides what is
 * visible; if a policy is wrong the screen goes blank rather than leaking, which
 * is the intended failure direction.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

interface Delivery {
  id: string;
  trace_id: string;
  status: string;
  destination_address: string | null;
  eta_at: string | null;
}

/** Plain language: the recipient is not reading a state machine. */
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

export function TrackingView({ token }: { token: string }) {
  const supabase = useMemo(
    () =>
      createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      ),
    [],
  );

  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [riderMoving, setRiderMoving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  // Claim once: anonymous session, then bind it to this one delivery.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data: existing } = await supabase.auth.getSession();
      if (!existing.session) {
        const { error: signInError } = await supabase.auth.signInAnonymously();
        if (signInError) {
          if (!cancelled) {
            setFatal(
              signInError.message.toLowerCase().includes('disabled')
                ? 'Tracking is not available yet. Anonymous sign-in is switched off for this project.'
                : 'We could not open your delivery. Please try again shortly.',
            );
          }
          return;
        }
      }

      const { data, error: claimError } = await supabase.rpc('claim_tracking_token', {
        p_token: token,
      });

      if (cancelled) return;
      if (claimError || !data) {
        setFatal('This tracking link is no longer valid.');
        return;
      }
      setDeliveryId(data as string);
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase, token]);

  const load = useCallback(async () => {
    if (!deliveryId) return;
    const { data } = await supabase
      .from('deliveries')
      .select('id, trace_id, status, destination_address, eta_at')
      .eq('id', deliveryId)
      .maybeSingle();
    if (data) setDelivery(data as Delivery);
  }, [supabase, deliveryId]);

  useEffect(() => {
    if (!deliveryId) return;
    void load();

    const channel = supabase
      .channel(`track:${deliveryId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'deliveries',
          filter: `id=eq.${deliveryId}`,
        },
        () => void load(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rider_positions' },
        () => {
          // RLS limits this to the rider on this delivery, and only while the
          // delivery is in a state the recipient may watch.
          setRiderMoving(true);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, deliveryId, load]);

  const confirmReceipt = useCallback(async () => {
    if (!deliveryId) return;
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
      const message = rpcError.message;
      setError(
        message.includes('OUTSIDE_GEOFENCE')
          ? 'Your rider does not appear to be at the delivery address yet.'
          : message.includes('POSITION_REQUIRED')
            ? 'We cannot see your rider’s location right now. Please try again shortly.'
            : 'That did not go through. Please try again.',
      );
      setConfirming(false);
      return;
    }

    await load();
    setConfirming(false);
  }, [supabase, deliveryId, load]);

  if (fatal) {
    return (
      <Shell>
        <p className="text-center text-mist-400">{fatal}</p>
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
        <p className="wrap-hard mt-6 text-sm text-mist-400">{delivery.destination_address}</p>
      )}

      {riderMoving && !done && (
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
