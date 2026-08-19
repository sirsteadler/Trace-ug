/**
 * Device GPS acquisition. CON-001: rider position originates strictly from the
 * device. No mapping API, cell-tower lookup or IP geolocation is ever consulted.
 *
 * NFR-PRV-001: acquisition exists only inside an open shift. `stop()` is not a
 * pause — it releases the watch and the caller deletes the live position row.
 */
import { detectAnomalies, fallbackPingInterval, type Anomaly, type Fix, type GeofenceVerdict } from './geofence';

export type PermissionOutcome = 'granted' | 'denied' | 'unavailable' | 'timeout';

export interface TrackerEvent {
  readonly fix: Fix;
  readonly anomalies: readonly Anomaly[];
}

export type TrackerListener = (event: TrackerEvent) => void;
export type TrackerErrorListener = (outcome: PermissionOutcome) => void;

/** Movement below this between fixes counts as stationary. NFR-CST-001. */
const STATIONARY_THRESHOLD_M = 15;

interface StartOptions {
  readonly onFix: TrackerListener;
  readonly onError: TrackerErrorListener;
  /** Supplies the current geofence verdict so the interval can adapt. */
  readonly verdict: () => GeofenceVerdict;
  /** Server-issued interval overrides the local fallback. §6.1.3. */
  readonly serverInterval: () => number | null;
}

function classify(err: GeolocationPositionError): PermissionOutcome {
  if (err.code === err.PERMISSION_DENIED) return 'denied';
  if (err.code === err.TIMEOUT) return 'timeout';
  return 'unavailable';
}

export class GpsTracker {
  #watchId: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #previous: Fix | null = null;
  #latest: Fix | null = null;
  #stopped = true;

  get latest(): Fix | null {
    return this.#latest;
  }

  get running(): boolean {
    return !this.#stopped;
  }

  /**
   * FR-RDR-013: if geolocation is missing or refused we report it and return.
   * We never throw into the render tree and never retry in a loop — a rider
   * whose phone is asking for permission must still be able to use every
   * non-positional action.
   */
  start(options: StartOptions): void {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      options.onError('unavailable');
      return;
    }
    this.#stopped = false;

    this.#watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (this.#stopped) return;
        const fix: Fix = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy,
          device_time: new Date(pos.timestamp).toISOString(),
        };
        const anomalies = detectAnomalies(fix, this.#previous);
        this.#previous = this.#latest;
        this.#latest = fix;
        options.onFix({ fix, anomalies });
        this.#reschedule(options);
      },
      (err) => {
        if (this.#stopped) return;
        options.onError(classify(err));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  }

  /**
   * The adaptive rate is applied by throttling what we *publish*, not by
   * tearing the watch down and rebuilding it: a cold GPS re-acquisition costs
   * far more battery than holding a warm watch.
   */
  #reschedule(options: StartOptions): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    const stationary =
      this.#previous !== null &&
      this.#latest !== null &&
      Math.abs(this.#latest.lat - this.#previous.lat) < 1e-4 &&
      Math.abs(this.#latest.lng - this.#previous.lng) < 1e-4;

    const seconds = options.serverInterval() ?? fallbackPingInterval(options.verdict(), stationary);
    if (seconds <= 0) return;
    this.#timer = setTimeout(() => {
      /* next watchPosition callback will fire naturally; timer paces publishing */
    }, seconds * 1000);
  }

  /** NFR-PRV-001 / FR-RDR-003. Releases the watch and forgets the last fix. */
  stop(): void {
    this.#stopped = true;
    if (this.#watchId !== null && typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(this.#watchId);
    }
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#watchId = null;
    this.#timer = null;
    this.#previous = null;
    this.#latest = null;
  }
}

export function isStationary(a: Fix | null, b: Fix | null): boolean {
  if (!a || !b) return false;
  const dLat = (a.lat - b.lat) * 111_320;
  const dLng = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng) < STATIONARY_THRESHOLD_M;
}
