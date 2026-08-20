'use client';

/**
 * Operations wallboard. SRS §5.1, concept note §5.4.
 *
 * Opened full-screen on a television in the dispatch office and never touched
 * again. §5.4 is explicit that its purpose is NOT to show management the map —
 * it is to say where attention is required. So the composition itself is the
 * alert: late deliveries are rendered at display size and take the screen,
 * on-time ones collapse to a tally, and when nothing is wrong the board is
 * nearly empty and says so in one line.
 *
 * Attention is allocated by pixel area. A dispatcher three metres away should
 * know whether to walk over before resolving a single glyph.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { fetchActiveDeliveries, fetchHealthSummary } from '@/lib/dashboard/queries';
import { byUrgency, type DeliveryRow, type HealthSummary } from '@/lib/dashboard/types';

/** Belt and braces: Realtime drives updates, this catches a dropped socket. */
const POLL_MS = 30_000;

export default function WallboardPage() {
  const [rows, setRows] = useState<DeliveryRow[]>([]);
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [clock, setClock] = useState('');
  const [stale, setStale] = useState(false);

  const load = useCallback(async () => {
    try {
      const [deliveries, health] = await Promise.all([
        fetchActiveDeliveries(),
        fetchHealthSummary(),
      ]);
      setRows([...deliveries].sort(byUrgency));
      setSummary(health);
      setStale(false);
    } catch {
      // A wallboard that silently freezes is worse than one that admits it.
      setStale(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const poll = setInterval(() => void load(), POLL_MS);

    const channel = supabase()
      .channel('wallboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, () =>
        void load(),
      )
      .subscribe();

    return () => {
      clearInterval(poll);
      void supabase().removeChannel(channel);
    };
  }, [load]);

  // The clock is not decoration: it is how a dispatcher across the room knows
  // the board is live rather than a frozen browser tab.
  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      );
    tick();
    const timer = setInterval(tick, 10_000);
    return () => clearInterval(timer);
  }, []);

  const exceptions = rows.filter((r) => r.health !== 'green');
  const onTime = rows.length - exceptions.length;

  return (
    <main className="flex h-dvh w-full flex-col overflow-hidden bg-ink-900 px-[2vw] py-[2vh]">
      <header className="flex shrink-0 items-baseline justify-between">
        <h1 className="text-[1.6vw] font-semibold uppercase tracking-[0.35em] text-mist-400">
          TRACE Dispatch
        </h1>
        <div className="flex items-baseline gap-[2vw]">
          {stale && (
            <span className="text-[1.2vw] uppercase tracking-[0.2em] text-warn-500">
              Reconnecting
            </span>
          )}
          <span className="text-[2vw] font-semibold tabular-nums text-mist-200">{clock}</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-[2vw] pt-[2vh]">
        <section className="flex min-h-0 flex-[3] flex-col">
          {exceptions.length === 0 ? (
            <QuietBoard active={summary?.active ?? rows.length} />
          ) : (
            <>
              <h2 className="shrink-0 pb-[1vh] text-[1.3vw] uppercase tracking-[0.3em] text-mist-400">
                Needs attention
              </h2>
              <div className="flex min-h-0 flex-1 flex-col gap-[1.2vh]">
                {exceptions.slice(0, 4).map((row) => (
                  <ExceptionCard key={row.id} row={row} />
                ))}
              </div>
            </>
          )}
        </section>

        <aside className="flex w-[22vw] shrink-0 flex-col gap-[1.5vh]">
          <Tally label="Active" value={summary?.active ?? rows.length} />
          <Tally label="On time" value={onTime} tone="go" />
          <Tally label="Completed today" value={summary?.completedToday ?? 0} />
        </aside>
      </div>
    </main>
  );
}

/**
 * The quiet state. Most wallboards have nothing to say when all is well and
 * fill the space with charts anyway; saying it in one line is the point.
 */
function QuietBoard({ active }: { active: number }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <p className="text-[5vw] font-semibold leading-none text-go-500">All on time</p>
      <p className="mt-[2vh] text-[1.6vw] uppercase tracking-[0.3em] text-mist-400">
        {active} {active === 1 ? 'delivery' : 'deliveries'} in progress
      </p>
    </div>
  );
}

/**
 * Red takes twice the height of amber. The ratio is the message: severity is
 * legible as composition before any number is read.
 */
function ExceptionCard({ row }: { row: DeliveryRow }) {
  const red = row.health === 'red';

  return (
    <article
      className={`flex min-h-0 items-center justify-between rounded-[0.6vw] px-[2vw] ${
        red ? 'flex-[2] bg-stop-500/15' : 'flex-1 bg-warn-500/12'
      }`}
    >
      <div className="min-w-0">
        <p
          className={`text-[1.2vw] uppercase tracking-[0.25em] ${
            red ? 'text-stop-500' : 'text-warn-500'
          }`}
        >
          {row.traceId}
        </p>
        <p
          className={`wrap-hard truncate font-semibold text-mist-100 ${
            red ? 'text-[2.6vw]' : 'text-[1.9vw]'
          }`}
        >
          {row.recipientName ?? 'Recipient not named'}
        </p>
        <p className="wrap-hard truncate text-[1.2vw] text-mist-400">
          {row.riderName ?? 'Unassigned'}
          {row.destinationAddress ? ` · ${row.destinationAddress}` : ''}
        </p>
      </div>

      <div className="shrink-0 pl-[2vw] text-right">
        <p
          className={`font-semibold leading-none tabular-nums ${
            red ? 'text-[5vw] text-stop-500' : 'text-[3.4vw] text-warn-500'
          }`}
        >
          {row.minutesLate !== null ? `+${row.minutesLate}` : '—'}
        </p>
        <p className="text-[1vw] uppercase tracking-[0.3em] text-mist-400">min late</p>
      </div>
    </article>
  );
}

function Tally({
  label,
  value,
  tone = 'mist',
}: {
  label: string;
  value: number;
  tone?: 'mist' | 'go';
}) {
  return (
    <div className="flex flex-1 flex-col justify-center rounded-[0.6vw] bg-ink-800 px-[1.5vw]">
      <p
        className={`text-[4.5vw] font-semibold leading-none tabular-nums ${
          tone === 'go' ? 'text-go-500' : 'text-mist-100'
        }`}
      >
        {value}
      </p>
      <p className="pt-[0.8vh] text-[1.1vw] uppercase tracking-[0.3em] text-mist-400">
        {label}
      </p>
    </div>
  );
}
