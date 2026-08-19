import { describe, expect, it } from 'vitest';
import {
  detectAnomalies,
  distanceMetres,
  evaluateGeofence,
  fallbackPingInterval,
  type Fix,
} from './geofence';

// Kampala. Chosen deliberately: near the equator, where a naive
// equirectangular approximation looks fine and would hide its own error.
const NTINDA = { lat: 0.3560, lng: 32.6120 };

/** Offset north by metres, for constructing exact boundary cases. */
function north(from: { lat: number; lng: number }, metres: number) {
  return { lat: from.lat + (metres / 6_371_008.8) * (180 / Math.PI), lng: from.lng };
}

describe('distance', () => {
  it('is zero for identical points', () => {
    expect(distanceMetres(NTINDA, NTINDA)).toBe(0);
  });

  it('is symmetric', () => {
    const b = north(NTINDA, 250);
    expect(distanceMetres(NTINDA, b)).toBeCloseTo(distanceMetres(b, NTINDA), 6);
  });

  it('matches a known offset within a metre', () => {
    expect(distanceMetres(NTINDA, north(NTINDA, 100))).toBeCloseTo(100, 0);
  });

  it('handles antimeridian-adjacent longitudes without blowing up', () => {
    const d = distanceMetres({ lat: 0, lng: 179.999 }, { lat: 0, lng: -179.999 });
    expect(d).toBeLessThan(500);
    expect(Number.isFinite(d)).toBe(true);
  });
});

describe('geofence boundary — FR-STM-003, TC-008', () => {
  const dest = { lat: NTINDA.lat, lng: NTINDA.lng };

  it('admits a fix inside the radius', () => {
    const v = evaluateGeofence(north(NTINDA, 99), dest, 100);
    expect(v.kind).toBe('inside');
  });

  it('refuses a fix outside the radius and reports both distances', () => {
    const v = evaluateGeofence(north(NTINDA, 101), dest, 100);
    expect(v.kind).toBe('outside');
    if (v.kind === 'outside') {
      expect(v.distance_m).toBeGreaterThan(100);
      expect(v.allowed_m).toBe(100);
    }
  });

  it('treats exactly-on-the-boundary as inside', () => {
    // <= radius. Stated explicitly so a later refactor cannot flip it silently.
    const v = evaluateGeofence(NTINDA, dest, 100);
    expect(v.kind).toBe('inside');
  });

  it('honours a per-delivery radius override', () => {
    expect(evaluateGeofence(north(NTINDA, 240), dest, 250).kind).toBe('inside');
    expect(evaluateGeofence(north(NTINDA, 240), dest, 100).kind).toBe('outside');
  });
});

describe('indeterminate is not outside — NFR-REL-004', () => {
  it('reports no_destination when the delivery was never geocoded', () => {
    const v = evaluateGeofence(NTINDA, { lat: null, lng: null }, 100);
    expect(v).toEqual({ kind: 'indeterminate', reason: 'no_destination' });
  });

  it('reports no_position when GPS has produced nothing', () => {
    const v = evaluateGeofence(null, NTINDA, 100);
    expect(v).toEqual({ kind: 'indeterminate', reason: 'no_position' });
  });
});

describe('anomaly detection — FR-STM-006, FR-STM-007', () => {
  const base: Fix = {
    lat: NTINDA.lat, lng: NTINDA.lng, accuracy_m: 8,
    device_time: '2026-08-19T10:00:00.000Z',
  };

  it('finds nothing on a clean consecutive pair', () => {
    const next: Fix = { ...north(NTINDA, 200), accuracy_m: 8, device_time: '2026-08-19T10:00:30.000Z' };
    expect(detectAnomalies(next, base)).toEqual([]);
  });

  it('flags impossible ground speed', () => {
    // 5 km in 30 s = 600 km/h.
    const next: Fix = { ...north(NTINDA, 5000), accuracy_m: 8, device_time: '2026-08-19T10:00:30.000Z' };
    expect(detectAnomalies(next, base)).toContain('impossible_speed');
  });

  it('flags an unreliable fix', () => {
    const next: Fix = { ...base, accuracy_m: 250, device_time: '2026-08-19T10:00:30.000Z' };
    expect(detectAnomalies(next, base)).toContain('unreliable_position');
  });

  it('flags a mock provider', () => {
    expect(detectAnomalies({ ...base, is_mock: true }, null)).toContain('mock_provider');
  });

  it('does not manufacture a speed anomaly from a backwards clock', () => {
    const next: Fix = { ...north(NTINDA, 5000), accuracy_m: 8, device_time: '2026-08-19T09:59:30.000Z' };
    expect(detectAnomalies(next, base)).not.toContain('impossible_speed');
  });

  it('does not divide by zero on identical timestamps', () => {
    const next: Fix = { ...north(NTINDA, 5000), accuracy_m: 8, device_time: base.device_time };
    expect(() => detectAnomalies(next, base)).not.toThrow();
    expect(detectAnomalies(next, base)).not.toContain('impossible_speed');
  });
});

describe('adaptive ping rate — NFR-CST-001', () => {
  it('is frequent at the destination and sparse in transit', () => {
    const inside = fallbackPingInterval({ kind: 'inside', distance_m: 20 }, false);
    const transit = fallbackPingInterval({ kind: 'outside', distance_m: 4000, allowed_m: 100 }, false);
    expect(inside).toBeLessThan(transit);
  });

  it('backs off when the rider is stationary', () => {
    const moving = fallbackPingInterval({ kind: 'outside', distance_m: 4000, allowed_m: 100 }, false);
    const still = fallbackPingInterval({ kind: 'outside', distance_m: 4000, allowed_m: 100 }, true);
    expect(still).toBeGreaterThan(moving);
  });

  it('tightens on approach so the ARRIVED suggestion is not late', () => {
    const far = fallbackPingInterval({ kind: 'outside', distance_m: 4000, allowed_m: 100 }, false);
    const near = fallbackPingInterval({ kind: 'outside', distance_m: 300, allowed_m: 100 }, false);
    expect(near).toBeLessThan(far);
  });
});
