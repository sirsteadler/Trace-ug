/**
 * Seeded fixtures for the operations surfaces.
 *
 * The same pattern the SAP adapter uses: one interface, a mock behind it, and a
 * single environment variable choosing which is live. It exists so the
 * dashboard and wallboard can be built and reviewed before the schema is
 * applied, and so the wallboard's states — quiet, one late, several late — can
 * be inspected on demand rather than waited for.
 *
 * Never reachable in production: queries.ts only consults this when
 * NEXT_PUBLIC_TRACE_FIXTURES is explicitly '1'.
 */
import type { DeliveryRow, HealthSummary } from './types';

/** Minutes offset from now, so fixtures age realistically while you look at them. */
function etaFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export const FIXTURE_DELIVERIES: readonly DeliveryRow[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    traceId: 'TRC-260819-000044',
    status: 'IN_TRANSIT',
    health: 'red',
    minutesLate: 22,
    recipientName: 'Nakato Grace',
    destinationAddress: 'Plot 14, Kyaddondo Road, Nakasero',
    riderName: 'David Okello',
    etaAt: etaFromNow(-22),
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    traceId: 'TRC-260819-000051',
    status: 'ARRIVED',
    health: 'amber',
    minutesLate: 6,
    recipientName: 'Ssebunya Peter',
    destinationAddress: 'Ntinda Shopping Complex, Block C',
    riderName: 'Sarah Namulondo',
    etaAt: etaFromNow(-6),
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    traceId: 'TRC-260819-000048',
    status: 'IN_TRANSIT',
    health: 'green',
    minutesLate: -4,
    recipientName: 'Aine Brian',
    destinationAddress: 'Bugolobi Flats, House 22',
    riderName: 'David Okello',
    etaAt: etaFromNow(4),
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    traceId: 'TRC-260819-000049',
    status: 'PICKED_UP',
    health: 'green',
    minutesLate: -18,
    recipientName: 'Kirabo Joan',
    destinationAddress: 'Kololo, Prince Charles Drive',
    riderName: 'Sarah Namulondo',
    etaAt: etaFromNow(18),
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    traceId: 'TRC-260819-000050',
    status: 'ASSIGNED',
    health: 'green',
    minutesLate: null,
    recipientName: 'Wasswa Ronald',
    destinationAddress: 'Muyenga, Tank Hill Road',
    riderName: 'Joseph Mukasa',
    etaAt: null,
  },
];

export const FIXTURE_SUMMARY: HealthSummary = {
  active: 12,
  amber: 1,
  red: 1,
  completedToday: 47,
};

export function fixturesEnabled(): boolean {
  return process.env.NEXT_PUBLIC_TRACE_FIXTURES === '1';
}
