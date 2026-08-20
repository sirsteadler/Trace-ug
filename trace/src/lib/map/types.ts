/**
 * Map provider boundary. Concept note §11, decision 16.
 *
 * Everything above this interface is provider-agnostic. Google sits behind it as
 * §11 specifies; the seam exists because a mapping dependency is the single most
 * visible thing in the product and the easiest to lose to a billing problem.
 *
 * A MapLibre + OpenFreeMap implementation would satisfy the same interface. It
 * is deliberately not written: the fallback was insurance against having no
 * Google key, and there is now a key. The interface is what makes writing it
 * later a day rather than a rewrite.
 *
 * CON-001: rider position always originates on the device. No implementation of
 * this interface is ever asked where anybody is — it draws, geocodes and routes,
 * and nothing else.
 */

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/** What a marker means, so providers can style consistently. */
export type MarkerKind = 'rider' | 'destination' | 'pickup';

export interface MapHandle {
  /** Place or move a marker. Same id twice moves rather than duplicates. */
  setMarker(id: string, position: LatLng, kind: MarkerKind): void;
  removeMarker(id: string): void;
  /** Frame these points with padding. No-op for fewer than one point. */
  fitTo(points: readonly LatLng[]): void;
  /** Draw the destination geofence, so "outside the fence" is visible, not just enforced. */
  setGeofence(centre: LatLng, radiusMetres: number): void;
  destroy(): void;
}

export interface MapProvider {
  readonly name: 'google' | 'maplibre';
  /** Idempotent: repeated calls share one load. */
  create(container: HTMLElement, centre: LatLng, zoom: number): Promise<MapHandle>;
}

/** Thrown when a provider cannot start, so callers can degrade deliberately. */
export class MapUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'MapUnavailableError';
  }
}
