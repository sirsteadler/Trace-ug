/**
 * Google Maps Platform implementation. Concept note §11.
 *
 * Loaded through the inline bootstrap rather than a loader package: one fewer
 * dependency, and the customer tracking page is the one screen with a hard
 * budget on it (§03, under 5MB, on Ugandan mobile data).
 *
 * The browser key is restricted to Maps JavaScript and to our referrers. It is
 * visible in the bundle by necessity — that is what referrer restriction is for.
 * Geocoding and routing use a separate server key and never appear here.
 */
import {
  MapUnavailableError,
  type LatLng,
  type MapHandle,
  type MapProvider,
  type MarkerKind,
} from './types';

declare global {
  interface Window {
    google?: typeof google;
  }
}

let loading: Promise<void> | null = null;

function loadMapsApi(apiKey: string): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new MapUnavailableError('maps cannot load on the server'));
  }
  if (window.google?.maps) return Promise.resolve();

  // Shared, so several components mounting at once cause one network load.
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    const params = new URLSearchParams({
      key: apiKey,
      v: 'weekly',
      libraries: 'marker',
      loading: 'async',
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new MapUnavailableError('the Maps script failed to load'));
    };
    script.onload = () => resolve();
    document.head.appendChild(script);
  });

  return loading;
}

/** Health colours from the shared tokens, so the map reads as part of the system. */
const MARKER_STYLE: Record<MarkerKind, { fill: string; scale: number }> = {
  rider: { fill: '#2ee6a8', scale: 9 },
  destination: { fill: '#4aa8ff', scale: 7 },
  pickup: { fill: '#7d8fa3', scale: 6 },
};

export function googleMapProvider(apiKey: string): MapProvider {
  return {
    name: 'google',

    async create(container, centre, zoom) {
      if (!apiKey) {
        throw new MapUnavailableError('NEXT_PUBLIC_GOOGLE_MAPS_KEY is not set');
      }
      await loadMapsApi(apiKey);

      const map = new google.maps.Map(container, {
        center: centre,
        zoom,
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false,
        // Dark, because every surface in this product is (§5.2.2) and a map
        // that isn't is the thing that makes an app look assembled from parts.
        styles: DARK_STYLE,
      });

      const markers = new Map<string, google.maps.Marker>();
      let fence: google.maps.Circle | null = null;

      const handle: MapHandle = {
        setMarker(id, position, kind) {
          const existing = markers.get(id);
          if (existing) {
            existing.setPosition(position);
            return;
          }
          const style = MARKER_STYLE[kind];
          markers.set(
            id,
            new google.maps.Marker({
              map,
              position,
              icon: {
                path: google.maps.SymbolPath.CIRCLE,
                fillColor: style.fill,
                fillOpacity: 1,
                strokeColor: '#05070a',
                strokeWeight: 2,
                scale: style.scale,
              },
            }),
          );
        },

        removeMarker(id) {
          markers.get(id)?.setMap(null);
          markers.delete(id);
        },

        fitTo(points) {
          if (points.length === 0) return;
          if (points.length === 1) {
            map.setCenter(points[0]!);
            return;
          }
          const bounds = new google.maps.LatLngBounds();
          for (const p of points) bounds.extend(p);
          map.fitBounds(bounds, 64);
        },

        setGeofence(centrePoint, radiusMetres) {
          fence?.setMap(null);
          // Drawn so the recipient and dispatcher can SEE the rule the server
          // enforces. A geofence that only exists as a rejection message is
          // indistinguishable from a bug when it fires.
          fence = new google.maps.Circle({
            map,
            center: centrePoint,
            radius: radiusMetres,
            strokeColor: '#4aa8ff',
            strokeOpacity: 0.5,
            strokeWeight: 1,
            fillColor: '#4aa8ff',
            fillOpacity: 0.08,
          });
        },

        destroy() {
          for (const marker of markers.values()) marker.setMap(null);
          markers.clear();
          fence?.setMap(null);
          fence = null;
        },
      };

      return handle;
    },
  };
}

/** Minimal dark style. Fewer features, not recoloured chrome — a rider and a
 *  dispatcher both want roads and their own position, and nothing else. */
const DARK_STYLE: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#0b1017' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#7d8fa3' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#05070a' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1d2836' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#c3cedb' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#05070a' }] },
];
