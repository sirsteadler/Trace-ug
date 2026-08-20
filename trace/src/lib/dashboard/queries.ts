/**
 * Reads for the operations surfaces. SRS §5.1.
 *
 * Every query goes through deliveries_with_health, which computes GREEN/AMBER/
 * RED in one place so the dashboard and the wallboard cannot disagree about
 * whether a delivery is late. The view is security_invoker, so the RLS policies
 * on deliveries apply through it unchanged.
 */
import { supabase } from '@/lib/supabase/client';
import type { DeliveryStatus } from '@/lib/contract';
import type { DeliveryRow, Health, HealthSummary } from './types';
import { FIXTURE_DELIVERIES, FIXTURE_SUMMARY, fixturesEnabled } from './fixtures';

interface HealthViewRow {
  id: string;
  trace_id: string;
  status: DeliveryStatus;
  computed_health: Health;
  minutes_late: number | null;
  recipient_name: string | null;
  destination_address: string | null;
  eta_at: string | null;
  rider: { full_name: string } | { full_name: string }[] | null;
}

const SELECT =
  'id, trace_id, status, computed_health, minutes_late, recipient_name, destination_address, eta_at, rider:profiles!assigned_rider_id(full_name)';

function toRow(row: HealthViewRow): DeliveryRow {
  // PostgREST returns an embedded one-to-one as an object or a single-element
  // array depending on how it infers the relationship; normalise both.
  const rider = Array.isArray(row.rider) ? row.rider[0] : row.rider;
  return {
    id: row.id,
    traceId: row.trace_id,
    status: row.status,
    health: row.computed_health,
    minutesLate: row.minutes_late,
    recipientName: row.recipient_name,
    destinationAddress: row.destination_address,
    riderName: rider?.full_name ?? null,
    etaAt: row.eta_at,
  };
}

/** Everything not yet finished. The wallboard and the live list both use this. */
export async function fetchActiveDeliveries(): Promise<DeliveryRow[]> {
  if (fixturesEnabled()) return [...FIXTURE_DELIVERIES];

  const { data, error } = await supabase()
    .from('deliveries_with_health')
    .select(SELECT)
    .not('status', 'in', '("CONFIRMED","FAILED","RETURNED")')
    .order('eta_at', { ascending: true, nullsFirst: false });

  if (error) throw error;
  return (data as unknown as HealthViewRow[]).map(toRow);
}

export async function fetchHealthSummary(): Promise<HealthSummary> {
  if (fixturesEnabled()) return FIXTURE_SUMMARY;

  const { data, error } = await supabase().rpc('delivery_health_summary');
  if (error) throw error;

  const row = (data ?? {}) as Record<string, number>;
  return {
    active: row.active ?? 0,
    amber: row.amber ?? 0,
    red: row.red ?? 0,
    completedToday: row.completed_today ?? 0,
  };
}
