/**
 * Provider selection. Concept note §11, decision 16.
 *
 * One place decides which map implementation runs, so no component ever names
 * Google directly. Swapping to MapLibre means adding a branch here and writing
 * one file against the MapProvider interface.
 */
import { googleMapProvider } from './google';
import { MapUnavailableError, type MapProvider } from './types';

export * from './types';
export { googleMapProvider };

/**
 * Returns null rather than throwing when no provider is configured. A missing
 * map key should degrade the page to a status-only view, not break the
 * recipient's ability to confirm receipt — the ✓ Received button matters more
 * than the map it sits under.
 */
export function mapProvider(): MapProvider | null {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (key) return googleMapProvider(key);
  return null;
}

export function mapUnavailableReason(): string | null {
  return process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY
    ? null
    : 'NEXT_PUBLIC_GOOGLE_MAPS_KEY is not set';
}

export { MapUnavailableError };
