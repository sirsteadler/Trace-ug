/**
 * Geofence maths and GPS trustworthiness. SRS §4.3, FR-STM-003, FR-STM-006/007.
 *
 * The client computes distance ONLY to decide what to show the rider — to
 * auto-suggest ARRIVED (FR-RDR-008) and to warn before a completion that will
 * be refused. The server recomputes it and is the only thing that grants a
 * DELIVERED transition (CON-002). If these two ever disagree, the server wins.
 */

/** WGS-84 mean radius, metres. */
const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Haversine great-circle distance in metres.
 *
 * Chosen over the equirectangular approximation because the error of the cheap
 * version grows with latitude and we would rather not have a geofence that is
 * subtly wrong in one city and fine in another. The cost is irrelevant at the
 * rate we call it.
 */
export function distanceMetres(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type GeofenceVerdict =
  | { readonly kind: 'inside'; readonly distance_m: number }
  | { readonly kind: 'outside'; readonly distance_m: number; readonly allowed_m: number }
  | { readonly kind: 'indeterminate'; readonly reason: 'no_destination' | 'no_position' };

/**
 * A null destination coordinate is NOT "outside" — it is unknowable, and the
 * two must not be conflated. Treating unknown as outside would strand a rider
 * at a door because dispatch failed to geocode; treating it as inside would
 * hand away the anti-fraud property. So it gets its own branch and the caller
 * is forced to handle it. NFR-REL-004.
 */
export function evaluateGeofence(
  position: LatLng | null,
  destination: { lat: number | null; lng: number | null },
  radiusM: number,
): GeofenceVerdict {
  if (destination.lat === null || destination.lng === null) {
    return { kind: 'indeterminate', reason: 'no_destination' };
  }
  if (position === null) {
    return { kind: 'indeterminate', reason: 'no_position' };
  }
  const d = distanceMetres(position, { lat: destination.lat, lng: destination.lng });
  return d <= radiusM
    ? { kind: 'inside', distance_m: Math.round(d) }
    : { kind: 'outside', distance_m: Math.round(d), allowed_m: radiusM };
}

/** FR-STM-007. Beyond this, a fix cannot support a Tier 2-only completion. */
export const UNRELIABLE_ACCURACY_M = 200;

/** FR-STM-006. Ground speed above this between two fixes is not a motorcycle. */
export const IMPOSSIBLE_SPEED_KMH = 200;

export type Anomaly = 'impossible_speed' | 'unreliable_position' | 'mock_provider';

export interface Fix extends LatLng {
  readonly accuracy_m: number;
  readonly device_time: string;
  readonly is_mock?: boolean;
}

/**
 * Annotate a fix. Detection, never rejection: a false positive that blocks a
 * transition strands a rider in the field, which is a worse failure than a
 * flagged event a human reviews. FR-STM-006 says accept-and-flag, and this
 * mirrors it client side so the rider is warned before the server refuses.
 */
export function detectAnomalies(current: Fix, previous: Fix | null): readonly Anomaly[] {
  const found: Anomaly[] = [];

  if (current.is_mock === true) found.push('mock_provider');
  if (current.accuracy_m > UNRELIABLE_ACCURACY_M) found.push('unreliable_position');

  if (previous) {
    const seconds =
      (Date.parse(current.device_time) - Date.parse(previous.device_time)) / 1000;
    // Zero, negative or non-finite intervals mean a broken clock, not speed.
    // FR-STM-014 handles skew; do not manufacture a speed anomaly from it.
    if (Number.isFinite(seconds) && seconds > 0) {
      const kmh = (distanceMetres(previous, current) / seconds) * 3.6;
      if (kmh > IMPOSSIBLE_SPEED_KMH) found.push('impossible_speed');
    }
  }

  return found;
}

/**
 * NFR-CST-001. The server issues the authoritative interval (§6.1.3); this is
 * the local fallback used before the first response and while offline, so a
 * rider in a dead zone does not burn battery pinging at destination cadence.
 */
export const PING_INTERVAL_S = {
  atDestination: 6,
  inTransit: 25,
  stationary: 60,
  offShift: 0,
} as const;

export function fallbackPingInterval(
  verdict: GeofenceVerdict,
  isStationary: boolean,
): number {
  if (verdict.kind === 'inside') return PING_INTERVAL_S.atDestination;
  if (isStationary) return PING_INTERVAL_S.stationary;
  // Approaching: tighten within 500 m so the ARRIVED suggestion is not late.
  if (verdict.kind === 'outside' && verdict.distance_m < 500) {
    return PING_INTERVAL_S.atDestination * 2;
  }
  return PING_INTERVAL_S.inTransit;
}
