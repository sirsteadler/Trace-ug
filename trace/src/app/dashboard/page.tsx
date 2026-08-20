'use client';

/**
 * Active deliveries. SRS §5.1.1.
 *
 * Exception-first, like the wallboard, but readable rather than declamatory: a
 * dispatcher at a desk needs the whole list, ordered so the things that need
 * them are at the top. Health is a coloured edge rather than a badge — a badge
 * is a word you read, an edge is a shape you scan.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import { fetchActiveDeliveries } from '@/lib/dashboard/queries';
import { byUrgency, type DeliveryRow } from '@/lib/dashboard/types';

const EDGE: Record<DeliveryRow['health'], string> = {
  red: 'border-l-stop-500',
  amber: 'border-l-warn-500',
  green: 'border-l-ink-500',
};

/** The rider's verb, not the enum. §5.1.2 asks for plain language throughout. */
const STATUS_LABEL: Record<string, string> = {
  CREATED: 'Unassigned',
  ASSIGNED: 'Awaiting acceptance',
  ACCEPTED: 'Heading to pickup',
  AT_PICKUP: 'At pickup',
  PICKED_UP: 'Collected',
  IN_TRANSIT: 'In transit',
  ARRIVED: 'At the door',
  DELIVERED: 'Delivered, unconfirmed',
  CONFIRMED: 'Confirmed',
  FAILED: 'Failed',
  RETURNED: 'Returned',
};

export default function DeliveriesPage() {
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchActiveDeliveries();
      setRows([...data].sort(byUrgency));
      setProblem(null);
    } catch {
      setProblem('Could not load deliveries. Check your connection and reload.');
    }
  }, []);

  useEffect(() => {
    void load();

    const channel = supabase()
      .channel('dashboard-deliveries')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, () =>
        void load(),
      )
      .subscribe();

    return () => {
      void supabase().removeChannel(channel);
    };
  }, [load]);

  if (problem) {
    return (
      <p role="alert" className="rounded-xl bg-ink-800 px-4 py-3 text-stop-500">
        {problem}
      </p>
    );
  }

  if (rows === null) {
    return <p className="text-mist-400">Loading deliveries…</p>;
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-ink-600 px-6 py-16 text-center">
        <p className="text-lg text-mist-100">Nothing in progress</p>
        <p className="mt-2 text-mist-400">
          Deliveries you create, or that arrive from SAP, appear here.
        </p>
        <Link
          href="/dashboard/new"
          className="mt-6 inline-block min-h-tap rounded-2xl bg-go-600 px-6 py-3 font-semibold text-ink-900"
        >
          Create a delivery
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold text-mist-100">Active deliveries</h1>
        <p className="text-sm text-mist-400">
          {rows.length} in progress · updating live
        </p>
      </div>

      <ul className="mt-6 space-y-2">
        {rows.map((row) => (
          <li key={row.id}>
            <Link
              href={`/dashboard/${row.id}`}
              className={`flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border-l-4 bg-ink-800 px-5 py-4 transition-colors hover:bg-ink-700 ${EDGE[row.health]}`}
            >
              <div className="min-w-0 flex-1">
                <p className="wrap-hard text-xs uppercase tracking-[0.2em] text-mist-400">
                  {row.traceId}
                </p>
                <p className="wrap-hard truncate font-medium text-mist-100">
                  {row.recipientName ?? 'Recipient not named'}
                </p>
                <p className="wrap-hard truncate text-sm text-mist-400">
                  {row.destinationAddress ?? 'No address'}
                </p>
              </div>

              <div className="text-sm text-mist-200">
                {STATUS_LABEL[row.status] ?? row.status}
              </div>

              <div className="w-28 text-sm text-mist-400">
                {row.riderName ?? 'Unassigned'}
              </div>

              <div className="w-24 text-right tabular-nums">
                {row.minutesLate === null ? (
                  <span className="text-mist-400">No ETA</span>
                ) : row.minutesLate > 0 ? (
                  <span className={row.health === 'red' ? 'text-stop-500' : 'text-warn-500'}>
                    {row.minutesLate} min late
                  </span>
                ) : (
                  <span className="text-mist-400">{Math.abs(row.minutesLate)} min early</span>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
