/**
 * A replay event = real historical rainfall (original timestamps) + a scenario file of ground reports
 * and road events. Scenario inputs are SYNTHETIC unless an entry carries a citation (origin "documented").
 * Scenario reports are extracted with the deterministic keyword extractor, so the replay is reproducible.
 *
 * Scenario entries refer to places and roads by NAME; they are resolved against the OSM data here, so
 * the scenario never contains invented coordinates. Unresolvable entries are skipped with a warning.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GroundReport, RainObservation, RoadEvent, RoadSegment, Settlement, WaterLevelObservation } from '../../../shared/types.js';
import { haversineM } from '../engine/geo.js';
import { keywordExtract } from '../intake/keyword.js';
import { DATA_DIR } from '../data/geography.js';

export interface ScenarioFile {
  meta: { title: string; labelling: string; notes?: string[] };
  start: string;
  end: string;
  step_min: number;
  /** Reference place used to disambiguate place names that occur more than once. */
  anchor?: string;
  reports: { at: string; place: string; offset_m?: [number, number]; text: string; reporter: string; location_confidence: number }[];
  /** Either `osm_way` (a real OpenStreetMap way id) or `road` (name pattern) + `near` (place). */
  road_events: { at: string; osm_way?: number; road?: string; near?: string; bridge?: boolean; action: 'close' | 'reopen'; reason: string; origin: 'scenario' | 'documented'; citation?: string }[];
  water_levels?: { at: string; gauge_id: string; level: number; unit: 'ft' | 'm'; citation: string }[];
}

export interface ReplayEvent {
  id: string;
  name: string;
  start: number;
  end: number;
  step_min: number;
  rain: RainObservation[];
  rainMeta: Record<string, unknown>;
  reports: GroundReport[];
  roadEvents: RoadEvent[];
  water: WaterLevelObservation[];
  scenarioMeta: ScenarioFile['meta'];
  warnings: string[];
}

export function listEvents(): { id: string; name: string; has_scenario: boolean }[] {
  const dir = join(DATA_DIR, 'replay');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((id) => existsSync(join(dir, id, 'rainfall.json'))).map((id) => {
    const meta = JSON.parse(readFileSync(join(dir, id, 'rainfall.json'), 'utf8')).meta as { event_name: string };
    return { id, name: meta.event_name, has_scenario: existsSync(join(dir, id, 'scenario.json')) };
  });
}

/**
 * Resolves a place name against OSM settlements. Several villages can share a name (e.g. two
 * "Chikhali"); `near` names a reference place and the closest match to it is used.
 */
function findPlace(name: string, settlements: Settlement[], near?: string): Settlement | undefined {
  const n = name.trim().toLowerCase();
  let matches = settlements.filter((s) => s.name.toLowerCase() === n);
  if (!matches.length) matches = settlements.filter((s) => s.name.toLowerCase().startsWith(n) || s.name_mr === name.trim());
  if (matches.length <= 1 || !near) return matches[0];
  const ref = findPlace(near, settlements);
  return ref ? [...matches].sort((a, b) => haversineM(a, ref) - haversineM(b, ref))[0] : matches[0];
}

function offset(p: { lat: number; lng: number }, [east, north]: [number, number]) {
  return { lat: p.lat + north / 110_540, lng: p.lng + east / (111_320 * Math.cos((p.lat * Math.PI) / 180)) };
}

export function loadEvent(id: string, settlements: Settlement[], segments: RoadSegment[]): ReplayEvent {
  const dir = join(DATA_DIR, 'replay', id);
  const rainFile = JSON.parse(readFileSync(join(dir, 'rainfall.json'), 'utf8')) as { meta: Record<string, unknown> & { event_name: string }; observations: RainObservation[] };
  const scenarioPath = join(dir, 'scenario.json');
  if (!existsSync(scenarioPath)) throw new Error(`Replay event ${id} has no scenario.json`);
  const sc = JSON.parse(readFileSync(scenarioPath, 'utf8')) as ScenarioFile;
  const warnings: string[] = [];

  const reports: GroundReport[] = [];
  sc.reports.forEach((r, i) => {
    const place = findPlace(r.place, settlements, sc.anchor);
    if (!place) { warnings.push(`report ${i + 1}: place "${r.place}" not found in settlements — skipped`); return; }
    const pos = offset(place, r.offset_m ?? [0, 0]);
    reports.push({
      id: `${id}-R${i + 1}`, text: r.text, received_at: r.at, lat: pos.lat, lng: pos.lng,
      location_confidence: r.location_confidence, reporter_ref: r.reporter, evidence: keywordExtract(r.text),
      verification: 'unverified', mode: 'synthetic_scenario',
    });
  });

  const roadEvents: RoadEvent[] = [];
  sc.road_events.forEach((e, i) => {
    const documented = e.origin === 'documented' && !!e.citation;
    const push = (segs: RoadSegment[]) => segs.forEach((seg, k) => roadEvents.push({
      id: `${id}-E${i + 1}${segs.length > 1 ? `.${k + 1}` : ''}`, segment_id: seg.id, action: e.action, at: e.at, reason: e.reason,
      origin: documented ? 'documented' : 'scenario', source: documented ? e.citation! : 'synthetic scenario (team-written)',
      mode: documented ? 'replay' : 'synthetic_scenario',
    }));
    if (e.osm_way !== undefined) {
      const segs = segments.filter((s) => s.osm_way_id === e.osm_way);
      if (!segs.length) warnings.push(`road event ${i + 1}: OSM way ${e.osm_way} not in the road network — skipped`);
      push(segs);
      return;
    }
    if (!e.road || !e.near) { warnings.push(`road event ${i + 1}: needs osm_way, or road + near — skipped`); return; }
    const near = findPlace(e.near, settlements, sc.anchor);
    if (!near) { warnings.push(`road event ${i + 1}: place "${e.near}" not found — skipped`); return; }
    const re = new RegExp(e.road, 'i');
    let best: { seg: RoadSegment; d: number } | null = null;
    for (const seg of segments) {
      if (!seg.name || !re.test(seg.name) || (e.bridge && !seg.is_bridge)) continue;
      const c = seg.coords[Math.floor(seg.coords.length / 2)];
      const d = haversineM({ lat: c[0], lng: c[1] }, near);
      if (d <= 8000 && (!best || d < best.d)) best = { seg, d };
    }
    if (!best) { warnings.push(`road event ${i + 1}: no road matching /${e.road}/${e.bridge ? ' (bridge)' : ''} within 8 km of ${e.near} — skipped`); return; }
    // A closure at a crossing shuts every carriageway there: dual carriageways are mapped as separate
    // one-way ways, so include same-named segments (same bridge flag) within 250 m of the match.
    const bc = best.seg.coords[Math.floor(best.seg.coords.length / 2)];
    // OSM tagging of the partner carriageway is often inconsistent (different ref, no bridge tag), so for
    // one-way roads the same-class one-way segment within 100 m is treated as the other carriageway.
    const dist = (seg: RoadSegment) => haversineM({ lat: seg.coords[Math.floor(seg.coords.length / 2)][0], lng: seg.coords[Math.floor(seg.coords.length / 2)][1] }, { lat: bc[0], lng: bc[1] });
    const crossing = segments.filter((seg) => (!!seg.name && re.test(seg.name) && seg.is_bridge === best!.seg.is_bridge && dist(seg) <= 250)
      || (best!.seg.oneway && seg.oneway && seg.road_class === best!.seg.road_class && dist(seg) <= 100));
    push(crossing);
  });

  const water: WaterLevelObservation[] = (sc.water_levels ?? []).filter((w) => {
    if (!w.citation) warnings.push(`water level at ${w.at} has no citation — skipped`);
    return !!w.citation;
  }).map((w) => ({ gauge_id: w.gauge_id, observed_at: w.at, level: w.level, unit: w.unit, source: w.citation, mode: 'replay' as const }));

  return {
    id, name: rainFile.meta.event_name, start: Date.parse(sc.start), end: Date.parse(sc.end), step_min: sc.step_min,
    rain: rainFile.observations, rainMeta: rainFile.meta, reports, roadEvents, water, scenarioMeta: sc.meta, warnings,
  };
}
