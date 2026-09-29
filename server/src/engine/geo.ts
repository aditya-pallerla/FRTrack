/** Small, dependency-free geometry helpers (metres, WGS84, local equirectangular projection). */

export interface LatLng { lat: number; lng: number }

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance (m) from point p to the segment a–b, using a local flat projection around p. */
export function pointToSegmentM(p: LatLng, a: LatLng, b: LatLng): number {
  const kx = 111_320 * Math.cos(rad(p.lat));
  const ky = 110_540;
  const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Distance (m) from a point to a polyline of [lat, lng] pairs. */
export function pointToPolylineM(p: LatLng, coords: [number, number][]): number {
  if (coords.length === 1) return haversineM(p, { lat: coords[0][0], lng: coords[0][1] });
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const d = pointToSegmentM(p, { lat: coords[i - 1][0], lng: coords[i - 1][1] }, { lat: coords[i][0], lng: coords[i][1] });
    if (d < best) best = d;
  }
  return best;
}

export function polylineLengthM(coords: [number, number][]): number {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    d += haversineM({ lat: coords[i - 1][0], lng: coords[i - 1][1] }, { lat: coords[i][0], lng: coords[i][1] });
  }
  return d;
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
