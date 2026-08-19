'use client';

/**
 * Rider home: shift toggle and the dispatch inbox.
 * NFR-USE-006: one primary action. Off shift it is "Go on shift"; on shift
 * with a live delivery it is the delivery itself.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { useShift } from '@/hooks/useShift';
import { SyncBar } from '@/components/rider/SyncBar';
import { PrimaryAction } from '@/components/rider/PrimaryAction';
import { ErrorBoundary } from '@/components/boundary/ErrorBoundary';
import { riderDeliverySchema, safeParse, type RiderDelivery } from '@/lib/contract';

const COLUMNS =
  'id,trace_id,status,recipient_name,recipient_phone,pickup_address,destination_address,' +
  'pickup_lat,pickup_lng,destination_lat,destination_lng,geofence_radius_m,' +
  'item_description,eta_at,promised_at,assigned_rider_id,created_at';

const ACTIVE = ['ASSIGNED', 'ACCEPTED', 'AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED'];

export default function RiderHome(): React.JSX.Element {
  const router = useRouter();
  const { shift, loading, blocked, goOnShift, goOffShift } = useShift();
  const [jobs, setJobs] = useState<readonly RiderDelivery[]>([]);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data: auth } = await supabase().auth.getUser();
      if (!auth.user) {
        router.replace('/rider/login');
        return;
      }
      setChecked(true);
    })();
  }, [router]);

  useEffect(() => {
    if (!shift) return;
    const load = async (): Promise<void> => {
      const { data } = await supabase().from('deliveries').select(COLUMNS).in('status', ACTIVE);
      const rows = (data ?? [])
        .map((r) => safeParse(riderDeliverySchema, r))
        .filter((p): p is { ok: true; value: RiderDelivery } => p.ok)
        .map((p) => p.value);
      setJobs(rows);
    };
    void load();

    const channel = supabase()
      .channel('rider-inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, () => void load())
      .subscribe();
    return () => {
      void supabase().removeChannel(channel);
    };
  }, [shift]);

  if (!checked || loading) {
    return <main className="p-6 text-mist-400">Loading…</main>;
  }

  // Derived, not stored: going off shift empties the list by definition, and
  // storing that as state would be a synchronous setState inside an effect.
  const visibleJobs = shift ? jobs : [];

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col">
      <ErrorBoundary module="Connection status">
        <SyncBar />
      </ErrorBoundary>

      <div className="flex-1 space-y-5 px-5 pb-6 pt-6">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-mist-100">
            {shift ? 'On shift' : 'Off shift'}
          </h1>
          <p className="mt-1 text-sm text-mist-400">
            {shift
              ? 'Your location is being shared while you are on shift.'
              : 'Your location is not being shared.'}
          </p>
        </header>

        {blocked ? (
          <div role="alert" className="rounded-xl border border-warn-500/40 bg-warn-500/10 p-4">
            <p className="font-semibold text-warn-500">
              {blocked.kind === 'unsynced'
                ? 'You still have work to send'
                : 'You are still carrying a package'}
            </p>
            <p className="mt-1 text-sm text-mist-200">
              {blocked.kind === 'unsynced'
                ? `${blocked.count} action${blocked.count === 1 ? '' : 's'} haven't reached the office yet. Stay on shift until they send.`
                : `Finish or return ${blocked.traceId} before you go off shift.`}
            </p>
          </div>
        ) : null}

        {shift ? (
          <ErrorBoundary module="Your deliveries">
            <section aria-label="Your deliveries" className="space-y-3">
              {visibleJobs.length === 0 ? (
                <p className="rounded-xl border border-ink-600 bg-ink-800 p-5 text-mist-400">
                  Nothing assigned to you right now. You&apos;ll get a notification.
                </p>
              ) : (
                visibleJobs.map((job) => (
                  <Link
                    key={job.id}
                    href={`/rider/delivery/${job.id}`}
                    className="block rounded-xl border border-ink-600 bg-ink-800 p-4"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-mono text-sm text-go-500">{job.trace_id}</span>
                      <span className="text-xs uppercase tracking-wide text-mist-400">
                        {job.status.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="wrap-hard mt-2 font-semibold text-mist-100">
                      {job.recipient_name}
                    </p>
                    <p className="wrap-hard mt-0.5 text-sm text-mist-400">
                      {job.destination_address}
                    </p>
                  </Link>
                ))
              )}
            </section>
          </ErrorBoundary>
        ) : null}
      </div>

      <div className="px-5 pb-8">
        <PrimaryAction
          label={shift ? 'Go off shift' : 'Go on shift'}
          tone={shift ? 'warn' : 'go'}
          hint={
            shift
              ? 'Tracking stops and your live position is deleted.'
              : 'We need your location while you are working. It stops when you go off shift.'
          }
          onPress={() => void (shift ? goOffShift() : goOnShift())}
        />
      </div>
    </main>
  );
}
