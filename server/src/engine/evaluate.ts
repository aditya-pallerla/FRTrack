/**
 * One full evaluation of the situation at the engine clock — the agreed flow, in order:
 *
 *   environmental data → initial risk → affected settlements → ground reports → risk + confidence
 *   → false-alert check → final warning → road analysis → route feasibility → response priority
 *   → resource recommendations (proposals only) → list of what changed since the last evaluation
 *
 * Pure with respect to storage: the caller supplies every input and keeps the returned state.
 */
import type {
  Assignment, GroundReport, RainObservation, ResponseBase, RiverGauge, RoadEvent, RoadSegment, Settlement,
  SettlementWarning, Situation, SituationChange, SystemMode, ReplayInfo, Unit, Verification, WaterLevelObservation,
} from '../../../shared/types.js';
import { allocate } from '../allocation/allocate.js';
import { RoadGraph } from '../routing/graph.js';
import { AccessCalculator } from './access.js';
import { assessSettlement, reportsForSettlement, type WaterInput } from './assess.js';
import { FRESHNESS } from './config.js';
import { levelRank } from './levels.js';
import { prioritise } from './priority.js';
import { aggregateCell } from './rainfall.js';
import { applyVerification } from './reports.js';
import { closuresNear, computeRoadStates } from './roads.js';
import { ageMin, ms } from './time.js';
import { versionWarning } from './versions.js';

export interface World {
  settlements: Settlement[];
  segments: RoadSegment[];
  bases: ResponseBase[];
  gauges: RiverGauge[];
  graph: RoadGraph;
  access: AccessCalculator;
}

export function buildWorld(settlements: Settlement[], segments: RoadSegment[], bases: ResponseBase[], gauges: RiverGauge[]): World {
  const graph = new RoadGraph(segments);
  return { settlements, segments, bases, gauges, graph, access: new AccessCalculator(graph, bases) };
}

export interface Inputs {
  mode: SystemMode;
  replay: ReplayInfo | null;
  rain: RainObservation[];
  water: WaterLevelObservation[];
  reports: GroundReport[];
  decisions: Map<string, Extract<Verification, 'verified' | 'disputed'>>;
  roadEvents: RoadEvent[];
  units: Unit[];
  assignments: Assignment[];
  rejected: Set<string>;
}

export function evaluate(world: World, inp: Inputs, now: number, prev: Situation | null): Situation {
  // Mode separation: in LIVE mode only live data is considered; in REPLAY only replay + synthetic.
  const allowed = inp.mode === 'live' ? new Set(['live']) : new Set(['replay', 'synthetic_scenario']);
  const rainObs = inp.rain.filter((o) => allowed.has(o.mode));
  const waterObs = inp.water.filter((o) => allowed.has(o.mode) && ms(o.observed_at) <= now);
  const roadEvents = inp.roadEvents.filter((e) => allowed.has(e.mode));
  const reports = applyVerification(inp.reports.filter((r) => allowed.has(r.mode)), inp.decisions, now);

  const segById = new Map(world.segments.map((s) => [s.id, s]));
  const prevWarnings = new Map((prev?.warnings ?? []).map((w) => [w.settlement_id, w]));

  // Rainfall per grid cell (each cell once).
  const cells = new Map<string, ReturnType<typeof aggregateCell>>();
  for (const s of world.settlements) {
    if (s.rain_cell && !cells.has(s.rain_cell)) cells.set(s.rain_cell, aggregateCell(s.rain_cell, rainObs, now));
  }
  const waterFor = (gaugeId: string | null): WaterInput | null => {
    if (!gaugeId) return null;
    const gauge = world.gauges.find((g) => g.id === gaugeId);
    if (!gauge) return null;
    const obs = waterObs.filter((o) => o.gauge_id === gaugeId).sort((a, b) => ms(a.observed_at) - ms(b.observed_at));
    return { gauge, latest: obs[obs.length - 1] ?? null, previous: obs[obs.length - 2] ?? null };
  };

  // Pass 1: confirmed closures (they do not depend on warnings).
  const closuresOnly = computeRoadStates({ segments: world.segments, reports, events: roadEvents, settlements: world.settlements, warnings: new Map(), now });

  // Warnings.
  const warnings = new Map<string, SettlementWarning>();
  const reportsBySettlement = new Map<string, GroundReport[]>();
  for (const s of world.settlements) {
    const mine = reportsForSettlement(s, reports, now);
    reportsBySettlement.set(s.id, mine);
    const previous = prevWarnings.get(s.id) ?? null;
    const w = assessSettlement({
      settlement: s, now, rain: s.rain_cell ? cells.get(s.rain_cell) ?? null : null, water: waterFor(s.gauge_id),
      reports: mine, closures: closuresNear(s, closuresOnly, segById), previous,
    });
    warnings.set(s.id, versionWarning(previous, w));
  }

  // Pass 2: road statuses including AT_RISK around warned settlements.
  const roads = computeRoadStates({ segments: world.segments, reports, events: roadEvents, settlements: world.settlements, warnings, now });

  // Access, priority, recommendations.
  const access = world.access.compute(world.settlements, roads);
  const known = world.settlements.map((s) => s.population ?? 0);
  const priorities = prioritise(world.settlements.map((s) => ({
    settlement: s, warning: warnings.get(s.id)!, access: access.get(s.id), reports: reportsBySettlement.get(s.id) ?? [],
    maxPopulation: Math.max(1, ...known),
  })), new Map((prev?.priorities ?? []).map((p) => [p.settlement_id, p])));
  const settlementsById = new Map(world.settlements.map((s) => [s.id, s]));
  const alloc = allocate({
    units: inp.units, settlements: settlementsById, priorities, warnings, access, reportsBySettlement,
    assignments: inp.assignments, rejected: inp.rejected, graph: world.graph, statuses: roads,
  });

  // Freshness summary.
  const latestRain = rainObs.filter((o) => o.rainfall_mm !== null && ms(o.observed_at) <= now).reduce((m, o) => Math.max(m, ms(o.observed_at)), -Infinity);
  const rainAge = Number.isFinite(latestRain) ? ageMin(new Date(latestRain).toISOString(), now) : null;
  const latestReport = reports.reduce((m, r) => Math.max(m, ms(r.received_at)), -Infinity);
  const latestWater = waterObs.reduce((m, o) => Math.max(m, ms(o.observed_at)), -Infinity);

  const situation: Situation = {
    mode: inp.mode, replay: inp.replay, as_of: new Date(now).toISOString(),
    warnings: [...warnings.values()],
    roads: [...roads.values()],
    access: [...access.values()],
    priorities,
    recommendations: alloc.recommendations,
    assignments: inp.assignments,
    units: inp.units,
    unmet: alloc.unmet,
    reports,
    changes: [],
    freshness: {
      rain_age_min: rainAge,
      report_age_min: Number.isFinite(latestReport) ? ageMin(new Date(latestReport).toISOString(), now) : null,
      water_age_min: Number.isFinite(latestWater) ? ageMin(new Date(latestWater).toISOString(), now) : null,
      rain_stale: rainAge === null || rainAge > FRESHNESS.rain.stale,
    },
  };
  situation.changes = diffSituations(prev, situation, settlementsById, segById);
  return situation;
}

/** Human-readable list of what changed between two evaluations. */
export function diffSituations(prev: Situation | null, cur: Situation, settlements: Map<string, Settlement>, segs: Map<string, RoadSegment>): SituationChange[] {
  const at = cur.as_of;
  const out: SituationChange[] = [];
  const name = (id: string) => settlements.get(id)?.name ?? id;
  const pw = new Map((prev?.warnings ?? []).map((w) => [w.settlement_id, w]));
  for (const w of cur.warnings) {
    const p = pw.get(w.settlement_id);
    const before = p?.level ?? 'NONE';
    if (w.level !== before) {
      const up = levelRank(w.level) > levelRank(before);
      out.push({
        at, settlement_id: w.settlement_id,
        type: before === 'NONE' ? 'warning_created' : up ? 'warning_escalated' : 'warning_downgraded',
        message: `${name(w.settlement_id)}: ${before} → ${w.level}. ${w.reason_for_change ?? ''}`.trim(),
      });
    }
    if (w.verification_requested && !p?.verification_requested) {
      out.push({ at, settlement_id: w.settlement_id, type: 'verification_requested', message: `${name(w.settlement_id)}: verification requested — ${w.false_alert_notes[w.false_alert_notes.length - 1] ?? ''}` });
    }
  }
  const pr = new Map((prev?.roads ?? []).map((r) => [r.segment_id, r]));
  const cr = new Map(cur.roads.map((r) => [r.segment_id, r]));
  for (const id of new Set([...pr.keys(), ...cr.keys()])) {
    const a = pr.get(id)?.status ?? 'OPEN';
    const b = cr.get(id)?.status ?? 'OPEN';
    if (a !== b) {
      const seg = segs.get(id);
      out.push({ at, segment_id: id, type: 'road_status_changed', message: `${seg?.name ?? 'Unnamed road'} (${id}): ${a} → ${b}${cr.get(id) ? ` — ${cr.get(id)!.reason}` : ''}` });
    }
  }
  const pa = new Map((prev?.access ?? []).map((a) => [a.settlement_id, a]));
  for (const a of cur.access) {
    const p = pa.get(a.settlement_id);
    if (!p || p.status === a.status) continue;
    if (a.status === 'CUT_OFF') out.push({ at, settlement_id: a.settlement_id, type: 'settlement_cut_off', message: `${name(a.settlement_id)} is CUT OFF: no road route from any response base.` });
    else if (a.status === 'DEGRADED' && p.status === 'REACHABLE') out.push({ at, settlement_id: a.settlement_id, type: 'route_invalidated', message: `${name(a.settlement_id)}: usual route disrupted. ${a.note ?? ''}` });
    if (a.status === 'DEGRADED' && a.route) out.push({ at, settlement_id: a.settlement_id, type: 'alternate_route_found', message: `${name(a.settlement_id)}: alternative route ${Math.round(a.route.duration_s / 60)} min (${a.eta_delta_min != null && a.eta_delta_min >= 0 ? '+' : ''}${a.eta_delta_min ?? '?'} min vs normal).` });
  }
  const pp = new Map((prev?.priorities ?? []).map((p) => [p.settlement_id, p]));
  const warnedIds = new Set(cur.warnings.filter((w) => levelRank(w.level) >= levelRank('WARNING')).map((w) => w.settlement_id));
  for (const p of cur.priorities) {
    const o = pp.get(p.settlement_id);
    // Report band changes, and warned settlements entering or leaving the top 5 (not every tie reshuffle).
    const topMove = warnedIds.has(p.settlement_id) && (o?.rank ?? 99) > 5 !== p.rank > 5;
    if (o && (o.band !== p.band || topMove)) {
      out.push({ at, settlement_id: p.settlement_id, type: 'priority_changed', message: `${name(p.settlement_id)}: priority #${o.rank} ${o.band} → #${p.rank} ${p.band}${p.changes.length ? ` (${p.changes.join('; ')})` : ''}` });
    }
  }
  const key = (r: { unit_id: string; settlement_id: string; kind: string }) => `${r.unit_id}|${r.settlement_id}|${r.kind}`;
  const prevRecs = new Set((prev?.recommendations ?? []).map(key));
  const newRecs = cur.recommendations.filter((r) => !prevRecs.has(key(r)));
  if (newRecs.length) {
    out.push({ at, type: 'recommendation_changed', message: `${newRecs.length} new recommendation${newRecs.length > 1 ? 's' : ''}: ${newRecs.map((r) => `${r.kind} → ${name(r.settlement_id)} (ETA ${r.eta_min} min)`).join('; ')}` });
  }
  return out;
}
