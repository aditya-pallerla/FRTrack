/** Parsing of the raw Overpass extracts (data/raw/osm-*.json) into typed building blocks. */
import { join } from 'node:path';
import type { RoadSegment } from '../../shared/types.js';
import { haversineM, polylineLengthM } from '../../server/src/engine/geo.js';
import { RAW, loadJson } from './common.js';

interface OsmNode { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
interface OsmWay { type: 'way'; id: number; nodes: number[]; geometry: { lat: number; lon: number }[]; tags?: Record<string, string>; center?: { lat: number; lon: number } }
interface OsmRel { type: 'relation'; id: number; members: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[]; tags?: Record<string, string>; center?: { lat: number; lon: number } }
type OsmElement = OsmNode | OsmWay | OsmRel;

const load = (name: string) => loadJson<{ elements: OsmElement[] }>(join(RAW, `osm-${name}.json`)).elements;

/** Free-flow speeds by road class (km/h). Prototype values for rural/peri-urban Maharashtra roads. */
export const SPEED_KMH: Record<string, number> = {
  motorway: 80, trunk: 60, primary: 50, secondary: 40, tertiary: 35, unclassified: 25,
  motorway_link: 40, trunk_link: 35, primary_link: 30, secondary_link: 30, tertiary_link: 25,
};

export interface River { id: number; name: string | null; coords: [number, number][] }
export interface Place { id: number; name: string; name_mr: string | null; place: string; lat: number; lng: number; population: number | null }
export interface Facility { id: string; name: string; amenity: string; lat: number; lng: number; emergency: boolean }

export function boundaryLines(): [number, number][][] {
  const rel = load('boundary').find((e): e is OsmRel => e.type === 'relation');
  if (!rel) throw new Error('District boundary relation not found in osm-boundary.json');
  return rel.members.filter((m) => m.type === 'way' && m.geometry).map((m) => m.geometry!.map((p) => [p.lat, p.lon] as [number, number]));
}

export function rivers(): River[] {
  return load('rivers').filter((e): e is OsmWay => e.type === 'way' && !!e.geometry)
    .map((w) => ({ id: w.id, name: w.tags?.name ?? null, coords: w.geometry.map((p) => [p.lat, p.lon] as [number, number]) }));
}

export function places(): Place[] {
  return load('places').filter((e): e is OsmNode => e.type === 'node' && !!e.tags?.name).map((n) => {
    const pop = Number(String(n.tags!.population ?? '').replace(/[, ]/g, ''));
    return {
      id: n.id, name: n.tags!['name:en'] ?? n.tags!.name, name_mr: n.tags!['name:mr'] ?? null, place: n.tags!.place,
      lat: n.lat, lng: n.lon, population: Number.isFinite(pop) && pop > 0 ? Math.round(pop) : null,
    };
  });
}

export function facilities(): Facility[] {
  return load('facilities').flatMap((e) => {
    const pos = e.type === 'node' ? { lat: e.lat, lon: e.lon } : e.center;
    const name = e.tags?.name;
    if (!pos || !name) return [];
    return [{ id: `${e.type[0]}${e.id}`, name, amenity: e.tags!.amenity, lat: pos.lat, lng: pos.lon, emergency: e.tags?.emergency === 'yes' }];
  });
}

/** Road ways split into routable segments at every junction (a node shared by two or more ways). */
export function roadSegments(): RoadSegment[] {
  const ways = load('roads').filter((e): e is OsmWay => e.type === 'way' && !!e.geometry && e.nodes?.length === e.geometry.length);
  const uses = new Map<number, number>();
  for (const w of ways) for (const [i, n] of w.nodes.entries()) {
    // End points always split; interior nodes split when shared.
    uses.set(n, (uses.get(n) ?? 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1));
  }
  const segs: RoadSegment[] = [];
  for (const w of ways) {
    const t = w.tags ?? {};
    const cls = t.highway;
    const maxspeed = Number.parseInt(t.maxspeed ?? '', 10);
    const speed = Number.isFinite(maxspeed) && maxspeed > 5 ? Math.min(maxspeed, SPEED_KMH[cls] ?? 30) : SPEED_KMH[cls] ?? 30;
    const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || t.junction === 'roundabout';
    const reverse = t.oneway === '-1';
    let start = 0;
    let k = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if ((uses.get(w.nodes[i]) ?? 0) < 2 && i < w.nodes.length - 1) continue;
      let coords = w.geometry.slice(start, i + 1).map((p) => [p.lat, p.lon] as [number, number]);
      let from = `n${w.nodes[start]}`;
      let to = `n${w.nodes[i]}`;
      if (reverse) { coords = coords.reverse(); [from, to] = [to, from]; }
      const length = polylineLengthM(coords);
      if (length > 0.5) {
        segs.push({
          id: `w${w.id}_${k++}`, osm_way_id: w.id, name: t.name ?? t.ref ?? null, road_class: cls, coords, from, to,
          length_m: Math.round(length * 10) / 10, speed_kmh: speed, oneway: oneway || reverse,
          is_bridge: !!t.bridge && t.bridge !== 'no', is_ford: t.ford === 'yes', flood_prone: false, flood_prone_reason: null,
        });
      }
      start = i;
    }
  }
  return segs;
}

/** Points every `stepM` metres along each river (for elevation sampling and distance-to-river). */
export function riverSamples(rs: River[], stepM = 500): { lat: number; lng: number; river: string | null }[] {
  const out: { lat: number; lng: number; river: string | null }[] = [];
  for (const r of rs) {
    let carry = 0;
    for (let i = 1; i < r.coords.length; i++) {
      const a = { lat: r.coords[i - 1][0], lng: r.coords[i - 1][1] };
      const b = { lat: r.coords[i][0], lng: r.coords[i][1] };
      const d = haversineM(a, b);
      let pos = stepM - carry;
      while (pos <= d) {
        const f = pos / d;
        out.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, river: r.name });
        pos += stepM;
      }
      carry = (carry + d) % stepM;
    }
  }
  return out;
}

/** Settlements in scope: every city/town, plus villages and suburbs within `maxRiverM` of a mapped river. */
export const SETTLEMENT_RIVER_RADIUS_M = 3000;
export function settlementCandidates(ps: Place[], riverIdx: PointIndex<{ lat: number; lng: number }>): Place[] {
  return ps.filter((p) => p.place === 'city' || p.place === 'town' || riverIdx.nearest(p, SETTLEMENT_RIVER_RADIUS_M) !== null);
}

/** Road segments whose middle lies within this distance of a river are checked for low elevation. */
export const ROAD_RIVER_RADIUS_M = 300;
export const midpoint = (s: RoadSegment) => { const c = s.coords[Math.floor(s.coords.length / 2)]; return { lat: c[0], lng: c[1] }; };

export const pointKey = (p: { lat: number; lng: number }) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

/** Simple spatial index (0.02° buckets) for nearest-point queries. */
export class PointIndex<T extends { lat: number; lng: number }> {
  private cells = new Map<string, T[]>();
  constructor(points: T[], private size = 0.02) {
    for (const p of points) {
      const k = this.key(p.lat, p.lng);
      const list = this.cells.get(k);
      if (list) list.push(p); else this.cells.set(k, [p]);
    }
  }
  private key(lat: number, lng: number) { return `${Math.floor(lat / this.size)}:${Math.floor(lng / this.size)}`; }
  nearest(p: { lat: number; lng: number }, maxM: number): { item: T; d: number } | null {
    const r = Math.ceil(maxM / (this.size * 100_000)) + 1;
    const ci = Math.floor(p.lat / this.size);
    const cj = Math.floor(p.lng / this.size);
    let best: { item: T; d: number } | null = null;
    for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
      for (const it of this.cells.get(`${i}:${j}`) ?? []) {
        const d = haversineM(p, it);
        if (d <= maxM && (!best || d < best.d)) best = { item: it, d };
      }
    }
    return best;
  }
}
