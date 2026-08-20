'use client';

/**
 * The live map. Concept note §5.3, demo step 5.
 *
 * Degrades deliberately: if no provider is configured or the script fails, this
 * renders nothing at all and the page around it still works. The ✓ Received
 * button matters more than the map it sits under, and a recipient who cannot
 * confirm because a tile server is down is a worse outcome than one who cannot
 * watch a dot move.
 */
import { useEffect, useRef, useState } from 'react';
import { mapProvider, type LatLng, type MapHandle } from '@/lib/map';

export function DeliveryMap({
  destination,
  rider,
  geofenceRadiusM,
  className = '',
}: {
  destination: LatLng | null;
  rider: LatLng | null;
  geofenceRadiusM?: number;
  className?: string;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const handle = useRef<MapHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // Create once. Position updates go through the effect below, so a moving
  // rider never causes a map rebuild.
  useEffect(() => {
    const provider = mapProvider();
    const el = container.current;
    if (!provider || !el) {
      setFailed(true);
      return;
    }

    let cancelled = false;
    const centre = destination ?? rider ?? { lat: 0.3476, lng: 32.5825 }; // Kampala

    provider
      .create(el, centre, 14)
      .then((created) => {
        if (cancelled) {
          created.destroy();
          return;
        }
        handle.current = created;
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      handle.current?.destroy();
      handle.current = null;
    };
    // Intentionally not reacting to position: the map is built once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = handle.current;
    if (!map || !ready) return;

    const points: LatLng[] = [];

    if (destination) {
      map.setMarker('destination', destination, 'destination');
      points.push(destination);
      if (geofenceRadiusM) map.setGeofence(destination, geofenceRadiusM);
    }

    if (rider) {
      map.setMarker('rider', rider, 'rider');
      points.push(rider);
    } else {
      map.removeMarker('rider');
    }

    map.fitTo(points);
  }, [ready, destination, rider, geofenceRadiusM]);

  if (failed) return null;

  return (
    <div
      ref={container}
      role="img"
      aria-label="Live delivery map"
      className={`w-full overflow-hidden rounded-2xl bg-ink-800 ${className}`}
    />
  );
}
