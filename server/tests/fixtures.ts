/**
 * TEST FIXTURES ONLY — synthetic geometry and observations used to test engine rules.
 * Nothing here is real data and none of it is used by the application.
 */
import type {
  GroundReport, RainObservation, ReportEvidence, ResponseBase, RoadSegment, Settlement, Verification,
} from '../../shared/types.js';
import { HOUR } from '../src/engine/time.js';

export const T0 = Date.parse('2021-07-22T08:30:00Z'); // 14:00 IST

export function settlement(over: Partial<Settlement> = {}): Settlement {
  return {
    id: 'S1', name: 'Test village', name_mr: null, kind: 'village', lat: 16.7, lng: 74.25,
    population: 5000, population_source: 'fixture', vulnerable_share: null, elevation_m: 540,
    height_above_river_m: 2, distance_to_river_m: 200, terrain_susceptibility: 0.9,
    road_node: 'n11', road_node_distance_m: 50, rain_cell: 'C1', gauge_id: null,
    sources: { terrain: { source: 'fixture' } },
    ...over,
  };
}

/** Hourly observations for cell C1 ending at `end`, newest last. */
export function hourly(values: (number | null)[], end = T0, cell = 'C1', mode: RainObservation['mode'] = 'replay'): RainObservation[] {
  return values.map((v, i) => ({
    cell_id: cell, lat: 16.7, lng: 74.25, observed_at: new Date(end - (values.length - 1 - i) * HOUR).toISOString(),
    interval_min: 60, rainfall_mm: v, source: 'fixture', mode,
  }));
}

export function evidence(over: Partial<ReportEvidence> = {}): ReportEvidence {
  return {
    kinds: ['water_in_homes'], road_blocked: false, people_trapped: 0, injured: 0, vulnerable_present: false,
    place_text: null, language: 'en', extractor: 'keyword', extractor_confidence_hint: null, ...over,
  };
}

let n = 0;
export function report(over: Partial<GroundReport> & { verification?: Verification } = {}): GroundReport {
  n++;
  return {
    id: `R${n}`, text: 'fixture report', received_at: new Date(T0 - 10 * 60_000).toISOString(),
    lat: 16.7005, lng: 74.2505, location_confidence: 0.9, reporter_ref: `reporter-${n}`,
    evidence: evidence(), verification: 'unverified', mode: 'synthetic_scenario', ...over,
  };
}

/**
 * A 4×4 grid road network (nodes n00..n33), ~1.1 km spacing, 40 km/h.
 * Horizontal segment id: h{r}{c} joins n{r}{c}–n{r}{c+1}; vertical v{r}{c} joins n{r}{c}–n{r+1}{c}.
 */
export function grid(): RoadSegment[] {
  const segs: RoadSegment[] = [];
  const pos = (r: number, c: number): [number, number] => [16.7 + r * 0.01, 74.25 + c * 0.01];
  const seg = (id: string, a: [number, number], b: [number, number], from: string, to: string): RoadSegment => ({
    id, osm_way_id: null, name: `Road ${id}`, road_class: 'secondary', coords: [a, b], from, to,
    length_m: 1100, speed_kmh: 40, oneway: false, is_bridge: false, is_ford: false, flood_prone: false, flood_prone_reason: null,
  });
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (c < 3) segs.push(seg(`h${r}${c}`, pos(r, c), pos(r, c + 1), `n${r}${c}`, `n${r}${c + 1}`));
    if (r < 3) segs.push(seg(`v${r}${c}`, pos(r, c), pos(r + 1, c), `n${r}${c}`, `n${r + 1}${c}`));
  }
  return segs;
}

export const BASE: ResponseBase = { id: 'B1', name: 'Test base', kind: 'fire_station', lat: 16.7, lng: 74.25, road_node: 'n00', source: 'fixture' };
