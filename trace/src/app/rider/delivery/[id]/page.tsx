'use client';

/**
 * The active delivery. One primary action, derived from delivery state via the
 * shared transition table — never a hard-coded screen sequence (NFR-MNT-003).
 */
import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRiderDelivery } from '@/hooks/useRiderDelivery';
import { SyncBar } from '@/components/rider/SyncBar';
import { PrimaryAction } from '@/components/rider/PrimaryAction';
import { ConfirmLadder } from '@/components/rider/ConfirmLadder';
import { ErrorBoundary } from '@/components/boundary/ErrorBoundary';
import { requestStatus, submitPinNow } from '@/lib/rider/actions';
import { GpsTracker, evaluateGeofence, type Fix, type GeofenceVerdict } from '@/lib/geo';
import {
  TraceError,
  allowedTransitions,
  type DeliveryStatus,
  type FallbackReason,
} from '@/lib/contract';

/** The verb a rider reads. One per state; nothing is inferred at render time. */
const ACTION_LABEL: Partial<Record<DeliveryStatus, string>> = {
  ASSIGNED: 'Accept this job',
  ACCEPTED: 'Arrived at pickup',
  AT_PICKUP: 'Package collected',
  PICKED_UP: 'Start delivery',
  IN_TRANSIT: 'Arrived at destination',
};

const NEXT_STATUS: Partial<Record<DeliveryStatus, DeliveryStatus>> = {
  ASSIGNED: 'ACCEPTED',
  ACCEPTED: 'AT_PICKUP',
  AT_PICKUP: 'PICKED_UP',
  PICKED_UP: 'IN_TRANSIT',
  IN_TRANSIT: 'ARRIVED',
};

export default function DeliveryScreen(
  props: { params: Promise<{ id: string }> },
): React.JSX.Element {
  const { id } = use(props.params);
  const router = useRouter();
  const { delivery, loading, problem } = useRiderDelivery(id);
  const [fix, setFix] = useState<Fix | null>(null);
  const [gpsProblem, setGpsProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const verdict: GeofenceVerdict = useMemo(
    () =>
      delivery
        ? evaluateGeofence(
            fix,
            { lat: delivery.destination_lat, lng: delivery.destination_lng },
            delivery.geofence_radius_m,
          )
        : { kind: 'indeterminate', reason: 'no_position' },
    [fix, delivery],
  );

  useEffect(() => {
    const tracker = new GpsTracker();
    tracker.start({
      onFix: (e) => setFix(e.fix),
      // FR-RDR-013: state which actions are blocked and why. Never crash,
      // never loop asking for permission.
      onError: (outcome) =>
        setGpsProblem(
          outcome === 'denied'
            ? 'Location is switched off. You can still call and view this job, but you cannot complete it until location is on.'
            : 'Waiting for a location fix. Move into the open if you can.',
        ),
      verdict: () => verdict,
      serverInterval: () => null,
    });
    return () => tracker.stop();
    // Deliberately mounted once per delivery: restarting the watch on every
    // verdict change would cold-start the GPS and drain the battery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const advance = useCallback(async (): Promise<void> => {
    if (!delivery) return;
    const to = NEXT_STATUS[delivery.status];
    if (!to) return;
    setBusy(true);
    await requestStatus({ deliveryId: delivery.id, to, fix });
    setBusy(false);
  }, [delivery, fix]);

  const submitPin = useCallback(
    async (pin: string): Promise<string | null> => {
      if (!delivery) return 'This delivery is no longer available.';
      try {
        // Not queued: the rider is standing in front of the recipient and must
        // be told the truth about whether the code was accepted.
        await submitPinNow({
          delivery_id: delivery.id,
          to_status: 'DELIVERED',
          idempotency_key: crypto.randomUUID(),
          device_time: new Date().toISOString(),
          position: fix
            ? { lat: fix.lat, lng: fix.lng, accuracy_m: fix.accuracy_m, device_time: fix.device_time }
            : null,
          confirmation: { method: 'pin_entry', pin, artifact_ref: null },
          reason: null,
          note: null,
          was_offline: false,
        });
        return null;
      } catch (error) {
        return error instanceof TraceError
          ? error.message
          : 'That did not go through. Try again.';
      }
    },
    [delivery, fix],
  );

  const fallback = useCallback(
    async (reason: FallbackReason): Promise<void> => {
      if (!delivery) return;
      await requestStatus({
        deliveryId: delivery.id,
        to: 'DELIVERED',
        fix,
        confirmation: { method: 'photograph' },
        note: reason,
      });
      router.replace('/rider');
    },
    [delivery, fix, router],
  );

  if (loading) return <main className="p-6 text-mist-400">Loading…</main>;
  if (problem || !delivery) {
    return (
      <main className="mx-auto max-w-md p-6">
        <p role="alert" className="text-mist-200">
          {problem ?? 'This delivery is not available.'}
        </p>
      </main>
    );
  }

  const canAdvance = allowedTransitions(delivery.status, 'rider').length > 0;
  const needsPosition = delivery.status === 'IN_TRANSIT' || delivery.status === 'ARRIVED';
  const label = ACTION_LABEL[delivery.status];

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col">
      <ErrorBoundary module="Connection status">
        <SyncBar />
      </ErrorBoundary>

      <div className="flex-1 space-y-5 px-5 pb-6 pt-5">
        <header>
          <span className="font-mono text-sm text-go-500">{delivery.trace_id}</span>
          <h1 className="wrap-hard mt-1 text-2xl font-bold text-mist-100">
            {delivery.recipient_name}
          </h1>
          <p className="wrap-hard mt-1 text-mist-400">{delivery.destination_address}</p>
        </header>

        {/* FR-RDR-009: one tap, native dialler. Never retype a number. */}
        <a
          href={`tel:${delivery.recipient_phone}`}
          className="flex min-h-tap items-center justify-center rounded-xl border
            border-ink-500 bg-ink-800 font-semibold text-mist-100"
        >
          Call {delivery.recipient_name.split(' ')[0]}
        </a>

        {gpsProblem ? (
          <p role="status" className="rounded-xl bg-warn-500/10 p-3 text-sm text-warn-500">
            {gpsProblem}
          </p>
        ) : null}

        {verdict.kind === 'outside' && needsPosition ? (
          <p className="rounded-xl bg-ink-800 p-3 text-sm text-mist-400">
            You are about {verdict.distance_m} m away. You need to be within{' '}
            {verdict.allowed_m} m to complete this.
          </p>
        ) : null}

        {delivery.status === 'ARRIVED' ? (
          <ErrorBoundary module="Confirmation">
            <ConfirmLadder
              deliveryId={delivery.id}
              recipientName={delivery.recipient_name}
              onSubmitPin={submitPin}
              onFallback={fallback}
            />
          </ErrorBoundary>
        ) : null}
      </div>

      {label && canAdvance ? (
        <div className="px-5 pb-8">
          <PrimaryAction
            label={label}
            busy={busy}
            disabled={needsPosition && verdict.kind !== 'inside'}
            hint={
              needsPosition && verdict.kind === 'indeterminate'
                ? 'Waiting for your location.'
                : needsPosition && verdict.kind === 'outside'
                  ? 'Get closer to the address first.'
                  : undefined
            }
            onPress={() => void advance()}
          />
        </div>
      ) : null}
    </main>
  );
}
