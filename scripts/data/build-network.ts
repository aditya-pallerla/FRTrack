/**
 * Step 3 — build the engine's geography from the raw extracts (no network access needed).
 *
 * Outputs (data/kolhapur/): settlements.json, roads.json, bases.json, units.json, gauges.json,
 * rivers.json, boundary.json, rain_cells.json, build-meta.json
 *
 * Every derived field records how it was derived. Nothing is estimated silently:
 *  - population: OSM `population` tag when present, otherwise null ("unknown")
 *  - terrain susceptibility: simplified HAND proxy from DEM elevations (engine/terrain.ts)
 *  - flood-prone roads: fords, bridges over rivers, and road points ≤4 m above a river within 300 m
 *  - units: SYNTHETIC demo fleet placed at real OSM facility locations (placement rule below)
 *
 *   npm run data:build
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ResponseBase, RiverGauge, RoadSegment, Settlement, Unit } from '../../shared/types.js';
import { haversineM } from '../../server/src/engine/geo.js';
import { terrainSusceptibility } from '../../server/src/engine/terrain.js';
import { BUILT, RAW, ROOT, loadJson, saveJson } from './common.js';
import {
  PointIndex, ROAD_RIVER_RADIUS_M, boundaryLines, facilities, midpoint, places, pointKey, riverSamples, rivers,
  roadSegments, settlementCandidates,
} from './osm.js';

const FLOOD_PRONE_HEIGHT_M = 4;
const SNAP_MAX_M = 3000;
const CELL_DEG = 0.1; // settlement rain cells; each takes the nearest ERA5 (0.25°) grid value

export const cellOf = (lat: number, lng: number) => {
  const la = Math.floor(lat / CELL_DEG) * CELL_DEG + CELL_DEG / 2;
  const lo = Math.floor(lng / CELL_DEG) * CELL_DEG + CELL_DEG / 2;
  return { id: `c${la.toFixed(2)}_${lo.toFixed(2)}`, lat: Number(la.toFixed(2)), lng: Number(lo.toFixed(2)) };
};

function largestComponent(segs: RoadSegment[]): Set<string> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => { (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); };
  for (const s of segs) { link(s.from, s.to); link(s.to, s.from); }
  const seen = new Set<string>();
  let best = new Set<string>();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp = new Set<string>([start]);
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      for (const n of adj.get(stack.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); comp.add(n); stack.push(n); }
    }
    if (comp.size > best.size) best = comp;
  }
  return best;
}

function main() {
  const elevation = loadJson<{ elevation_m: Record<string, number | null> }>(join(RAW, 'elevation.json')).elevation_m;
  const elev = (p: { lat: number; lng: number }) => elevation[pointKey(p)] ?? null;

  // ── Rivers ──
  const rs = rivers();
  const samples = riverSamples(rs).map((s) => ({ ...s, elev: elev(s) }));
  const riverIdx = new PointIndex(samples);

  // ── Roads: keep the largest connected network, flag flood-prone segments ──
  const all = roadSegments();
  const comp = largestComponent(all);
  const segs = all.filter((s) => comp.has(s.from) && comp.has(s.to));
  let flagged = 0;
  for (const s of segs) {
    const m = midpoint(s);
    const near = riverIdx.nearest(m, ROAD_RIVER_RADIUS_M);
    if (s.is_ford) { s.flood_prone = true; s.flood_prone_reason = 'Ford (road crosses the river bed)'; }
    else if (s.is_bridge && near) { s.flood_prone = true; s.flood_prone_reason = `Bridge over ${near.item.river ?? 'a river'}`; }
    else if (near && near.item.elev !== null) {
      const e = elev(m);
      if (e !== null && e - near.item.elev <= FLOOD_PRONE_HEIGHT_M) {
        s.flood_prone = true;
        s.flood_prone_reason = `Low-lying road ${Math.round(near.d)} m from ${near.item.river ?? 'river'}, ~${Math.max(0, Math.round(e - near.item.elev))} m above it`;
      }
    }
    if (s.flood_prone) flagged++;
  }
  console.log(`Roads: ${segs.length} segments in the main network (${all.length - segs.length} dropped as disconnected), ${flagged} flood-prone`);

  // ── Graph nodes for snapping ──
  const nodePos = new Map<string, { id: string; lat: number; lng: number }>();
  for (const s of segs) {
    nodePos.set(s.from, { id: s.from, lat: s.coords[0][0], lng: s.coords[0][1] });
    nodePos.set(s.to, { id: s.to, lat: s.coords[s.coords.length - 1][0], lng: s.coords[s.coords.length - 1][1] });
  }
  const nodeIdx = new PointIndex([...nodePos.values()]);

  // ── River gauges (location from OSM; reference levels only from the cited manual file) ──
  const gauges: RiverGauge[] = [];
  const manualPath = join(ROOT, 'data', 'manual', 'gauges.json');
  type ManualGauge = Omit<RiverGauge, 'lat' | 'lng'> & { osm_name_match: string };
  const manual = existsSync(manualPath) ? loadJson<{ gauges: ManualGauge[] }>(manualPath).gauges : [];
  const osmGauges = loadJson<{ elements: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] }>(join(RAW, 'osm-gauges.json')).elements;
  for (const { osm_name_match, ...g } of manual) {
    const hit = osmGauges.find((e) => e.tags?.name && new RegExp(osm_name_match, 'i').test(e.tags.name));
    const pos = hit ? (hit.type === 'node' ? { lat: hit.lat!, lon: hit.lon! } : hit.center) : undefined;
    if (!pos) { console.warn(`  gauge "${g.name}": no matching OSM feature — skipped (river-level evidence will show as a data gap)`); continue; }
    gauges.push({ ...g, lat: pos.lat, lng: pos.lon });
  }

  // ── Settlements ──
  const settlements: Settlement[] = [];
  for (const p of settlementCandidates(places(), riverIdx)) {
    const e = elev(p);
    const river = riverIdx.nearest(p, 20_000);
    const hand = e !== null && river?.item.elev != null ? Math.max(0, Math.round((e - river.item.elev) * 10) / 10) : null;
    const dist = river ? Math.round(river.d) : null;
    const snap = nodeIdx.nearest(p, SNAP_MAX_M);
    const cell = cellOf(p.lat, p.lng);
    const gauge = gauges.find((g) => river?.item.river && g.river && river.item.river.toLowerCase().includes(g.river.toLowerCase()) && haversineM(g, p) <= 15_000);
    settlements.push({
      id: `S${p.id}`, name: p.name, name_mr: p.name_mr, kind: p.place as Settlement['kind'], lat: p.lat, lng: p.lng,
      population: p.population, population_source: p.population !== null ? 'OpenStreetMap population tag' : null,
      vulnerable_share: null,
      elevation_m: e, height_above_river_m: hand, distance_to_river_m: dist,
      terrain_susceptibility: terrainSusceptibility(hand, dist),
      road_node: snap?.item.id ?? null, road_node_distance_m: snap ? Math.round(snap.d) : null,
      rain_cell: cell.id, gauge_id: gauge?.id ?? null,
      sources: {
        location: { source: 'OpenStreetMap place node' },
        terrain: { source: 'Copernicus DEM GLO-90 via Open-Meteo', note: `HAND proxy vs nearest river sample${river?.item.river ? ` (${river.item.river})` : ''}` },
        population: { source: p.population !== null ? 'OpenStreetMap population tag' : 'unknown' },
      },
    });
  }
  settlements.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`Settlements: ${settlements.length} (${settlements.filter((s) => s.population !== null).length} with population, ${settlements.filter((s) => !s.road_node).length} without road access)`);

  // ── Response bases (real OSM facilities, used as locations only) ──
  const kindOf = (a: string): ResponseBase['kind'] => (a === 'fire_station' ? 'fire_station' : a === 'police' ? 'police' : 'hospital');
  const bases: ResponseBase[] = facilities().flatMap((f) => {
    const snap = nodeIdx.nearest(f, 2000);
    return snap ? [{ id: `B${f.id}`, name: f.name, kind: kindOf(f.amenity), lat: f.lat, lng: f.lng, road_node: snap.item.id, source: 'OpenStreetMap' }] : [];
  });

  // ── SYNTHETIC demo fleet. Placement rule: bases serving the most in-scope settlements within 15 km. ──
  const coverage = (b: ResponseBase) => settlements.filter((s) => haversineM(s, b) <= 15_000).length;
  const top = (kind: ResponseBase['kind'], n: number) => bases.filter((b) => b.kind === kind).sort((a, b) => coverage(b) - coverage(a) || a.id.localeCompare(b.id)).slice(0, n);
  const units: Unit[] = [];
  const mk = (b: ResponseBase, type: Unit['type'], label: string, i: number, caps: string[]) => units.push({
    id: `U-${type}-${i}`, name: `${label} KOP-${i}`, type, base_id: b.id, road_node: b.road_node, status: 'available', capabilities: caps, synthetic: true,
  });
  // OSM currently has no fire stations tagged in the district; rescue teams and boats are then based at
  // police stations (documented in build-meta). They are synthetic demo units either way.
  const rescueKind: ResponseBase['kind'] = bases.some((b) => b.kind === 'fire_station') ? 'fire_station' : 'police';
  top(rescueKind, 6).forEach((b, i) => mk(b, 'rescue_team', 'Rescue Team', i + 1, ['rescue']));
  top(rescueKind, 4).forEach((b, i) => mk(b, 'rescue_boat', 'Rescue Boat', i + 1, ['water_rescue']));
  top('hospital', 6).forEach((b, i) => mk(b, 'ambulance', 'Ambulance', i + 1, ['medical']));
  top('police', 6).forEach((b, i) => mk(b, 'police', 'Police Mobile', i + 1, ['evacuation']));
  const usedBases = new Set(units.map((u) => u.base_id));
  console.log(`Bases: ${bases.length} facilities; demo fleet ${units.length} synthetic units at ${usedBases.size} of them`);

  // ── Rain cells ──
  const cells = new Map<string, { id: string; lat: number; lng: number }>();
  for (const s of settlements) { const c = cellOf(s.lat, s.lng); cells.set(c.id, c); }

  const meta = {
    built_at: new Date().toISOString(),
    study_area: 'Kolhapur District, Maharashtra',
    rules: {
      settlements: 'All cities/towns, plus villages/suburbs within 3 km of an OSM river',
      population: 'OSM population tag only; otherwise unknown (null)',
      terrain: 'HAND proxy: settlement DEM elevation minus nearest river-sample elevation (500 m samples); ~90 m DEM, noisy on small differences',
      flood_prone_roads: `Fords; bridges within ${ROAD_RIVER_RADIUS_M} m of a river; road mid-points within ${ROAD_RIVER_RADIUS_M} m of a river and ≤${FLOOD_PRONE_HEIGHT_M} m above it`,
      road_network: 'OSM motorway…unclassified (+links), largest connected component only',
      units: `SYNTHETIC demo units (not a real fleet), placed at OSM facilities serving the most settlements within 15 km; rescue teams/boats at ${bases.some((b) => b.kind === 'fire_station') ? 'fire stations' : 'police stations (no fire stations are tagged in OSM for this district)'}`,
      rain_cells: `${CELL_DEG}° cells, each filled from the nearest ERA5 0.25° grid point`,
    },
    counts: { settlements: settlements.length, segments: segs.length, bases: bases.length, units: units.length, gauges: gauges.length, rain_cells: cells.size },
  };
  saveJson(join(BUILT, 'settlements.json'), settlements);
  saveJson(join(BUILT, 'roads.json'), segs);
  saveJson(join(BUILT, 'bases.json'), bases);
  saveJson(join(BUILT, 'units.json'), units);
  saveJson(join(BUILT, 'gauges.json'), gauges);
  saveJson(join(BUILT, 'rivers.json'), rs.filter((r) => r.name).map((r) => ({ name: r.name, coords: r.coords })));
  saveJson(join(BUILT, 'boundary.json'), boundaryLines());
  saveJson(join(BUILT, 'rain_cells.json'), [...cells.values()]);
  saveJson(join(BUILT, 'build-meta.json'), meta);
}

main();
