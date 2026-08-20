/**
 * The shape the dashboard and wallboard read. SRS §5.1.
 *
 * Deliberately narrower than the deliveries table: an operations surface needs
 * to know who, where, how late — not the SAP document number or the notes
 * field. Narrow reads also keep the RLS surface small.
 */
import type { DeliveryStatus } from '@/lib/contract';

export type Health = 'green' | 'amber' | 'red';

export interface DeliveryRow {
  readonly id: string;
  readonly traceId: string;
  readonly status: DeliveryStatus;
  readonly health: Health;
  /** Signed: negative is early. Null when no ETA has been set. */
  readonly minutesLate: number | null;
  readonly recipientName: string | null;
  readonly destinationAddress: string | null;
  readonly riderName: string | null;
  readonly etaAt: string | null;
}

export interface HealthSummary {
  readonly active: number;
  readonly amber: number;
  readonly red: number;
  readonly completedToday: number;
}

/** Terminal states are finished, not late. Used by both surfaces. */
export function isTerminal(status: DeliveryStatus): boolean {
  return status === 'CONFIRMED' || status === 'FAILED' || status === 'RETURNED';
}

/**
 * Ordering for the wallboard: worst first, and within a health band the latest
 * first. A dispatcher scanning top-left finds the most urgent thing without
 * reading a single number.
 */
export function byUrgency(a: DeliveryRow, b: DeliveryRow): number {
  const rank: Record<Health, number> = { red: 0, amber: 1, green: 2 };
  if (rank[a.health] !== rank[b.health]) return rank[a.health] - rank[b.health];
  return (b.minutesLate ?? 0) - (a.minutesLate ?? 0);
}
