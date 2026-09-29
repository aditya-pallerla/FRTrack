/**
 * Response priority per settlement (0–100) — a transparent weighted score, recalculated on every
 * change, with a plain-language list of what moved it.
 *
 *   score = 100 × (0.30·level + 0.20·exposure + 0.15·vulnerability + 0.15·rescue + 0.10·access + 0.10·trend)
 *
 * Unknown population / vulnerability use a neutral 0.5 and are always listed as unknown — never
 * estimated silently. A settlement with no warning is capped at 30 (it cannot outrank flooded places
 * just because it is large or hard to reach). Weights are prototype values (config.ts).
 */
import type {
  AccessStatus, GroundReport, PriorityBand, PriorityComponents, Settlement, SettlementAccess,
  SettlementPriority, SettlementWarning, WarningLevel,
} from '../../../shared/types.js';
import { PRIORITY_BANDS, PRIORITY_WEIGHTS, UNKNOWN_NEUTRAL } from './config.js';
import { clamp01 } from './geo.js';

const LEVEL_VALUE: Record<WarningLevel, number> = { NONE: 0, WATCH: 1 / 3, WARNING: 2 / 3, SEVERE: 1 };
// Unknown access (no road data) gets a small flagged uplift, below DEGRADED, so data gaps never outrank real disruption.
const ACCESS_VALUE: Record<AccessStatus, number> = { REACHABLE: 0, DEGRADED: 0.5, CUT_OFF: 1, UNKNOWN: 0.25 };
const NO_WARNING_CAP = 30;

export interface PriorityInput {
  settlement: Settlement;
  warning: SettlementWarning;
  access: SettlementAccess | undefined;
  /** Reports attributed to this settlement (with verification applied). */
  reports: GroundReport[];
  /** Largest known population in the study area (for log scaling). */
  maxPopulation: number;
}

export function band(score: number): PriorityBand {
  if (score >= PRIORITY_BANDS.critical) return 'CRITICAL';
  if (score >= PRIORITY_BANDS.high) return 'HIGH';
  if (score >= PRIORITY_BANDS.medium) return 'MEDIUM';
  return 'LOW';
}

function scoreOne(inp: PriorityInput): { score: number; components: PriorityComponents; unknowns: string[] } {
  const { settlement: s, warning: w } = inp;
  const unknowns: string[] = [];

  let exposure = UNKNOWN_NEUTRAL;
  if (s.population !== null && s.population > 0 && inp.maxPopulation > 1) {
    exposure = clamp01(Math.log10(s.population + 1) / Math.log10(inp.maxPopulation + 1));
  } else unknowns.push('population');

  const live = inp.reports.filter((r) => r.verification !== 'disputed');
  let vulnerability = UNKNOWN_NEUTRAL;
  if (live.some((r) => r.evidence.vulnerable_present)) vulnerability = 1;
  else if (s.vulnerable_share !== null) vulnerability = clamp01(s.vulnerable_share / 0.2);
  else unknowns.push('vulnerable population');

  const rescueReports = live.filter((r) => r.evidence.people_trapped !== 0 || r.evidence.kinds.includes('rescue_needed') || r.evidence.kinds.includes('people_trapped'));
  const rescue = rescueReports.some((r) => r.verification !== 'unverified') ? 1 : rescueReports.length ? 0.6 : 0;

  const access = ACCESS_VALUE[inp.access?.status ?? 'UNKNOWN'];

  const rainTrend = w.evidence.find((e) => e.kind === 'rain_trend');
  // ±5 mm dead band so small hour-to-hour noise does not reshuffle priorities.
  const trend = rainTrend && typeof rainTrend.value === 'number' && !rainTrend.stale
    ? (rainTrend.value > 5 ? 1 : rainTrend.value < -5 ? 0 : 0.5)
    : UNKNOWN_NEUTRAL;

  const components: PriorityComponents = {
    level: LEVEL_VALUE[w.level], exposure, vulnerability, rescue, access, trend,
  };
  let score = 100 * Object.entries(PRIORITY_WEIGHTS).reduce((a, [k, wt]) => a + wt * components[k as keyof PriorityComponents], 0);
  if (w.level === 'NONE') score = Math.min(score, NO_WARNING_CAP);
  return { score: Math.round(score), components, unknowns };
}

/** Scores and ranks every settlement, and explains changes against the previous ranking. */
export function prioritise(inputs: PriorityInput[], previous: Map<string, SettlementPriority>): SettlementPriority[] {
  const scored = inputs.map((inp) => ({ inp, ...scoreOne(inp) }))
    .sort((a, b) => b.score - a.score || a.inp.settlement.name.localeCompare(b.inp.settlement.name));
  return scored.map((x, i) => {
    const prev = previous.get(x.inp.settlement.id) ?? null;
    const p: SettlementPriority = {
      settlement_id: x.inp.settlement.id, score: x.score, band: band(x.score), rank: i + 1,
      components: x.components, unknowns: x.unknowns,
      previous_rank: prev?.rank ?? null, previous_score: prev?.score ?? null, changes: [],
    };
    p.changes = explainChange(prev, p, x.inp);
    return p;
  });
}

const LEVEL_NAME = (v: number) => (v >= 1 ? 'SEVERE' : v >= 2 / 3 ? 'WARNING' : v >= 1 / 3 ? 'WATCH' : 'no warning');
const ACCESS_NAME = (v: number) => (v >= 1 ? 'CUT OFF' : v >= 0.5 ? 'DEGRADED' : 'REACHABLE');

function explainChange(prev: SettlementPriority | null, cur: SettlementPriority, inp: PriorityInput): string[] {
  if (!prev) return [];
  const out: string[] = [];
  const d = (k: keyof PriorityComponents) => cur.components[k] - prev.components[k];
  const sign = (x: number) => (x > 0 ? '+' : '−');
  if (Math.abs(d('level')) > 0.01) out.push(`${sign(d('level'))} warning ${LEVEL_NAME(prev.components.level)} → ${LEVEL_NAME(cur.components.level)}`);
  if (Math.abs(d('access')) > 0.01 && inp.access?.status !== 'UNKNOWN') out.push(`${sign(d('access'))} road access ${ACCESS_NAME(prev.components.access)} → ${ACCESS_NAME(cur.components.access)}`);
  if (Math.abs(d('rescue')) > 0.01) out.push(d('rescue') > 0 ? `+ ${cur.components.rescue >= 1 ? 'confirmed' : 'unverified'} rescue / trapped-people reports` : '− rescue reports no longer active');
  if (Math.abs(d('vulnerability')) > 0.01) out.push(`${sign(d('vulnerability'))} vulnerable people ${d('vulnerability') > 0 ? 'reported' : 'no longer reported'}`);
  if (Math.abs(d('trend')) > 0.01) out.push(d('trend') > 0 ? '+ rainfall increasing' : '− rainfall easing');
  if (prev.rank !== cur.rank && out.length === 0) out.push('Other settlements changed priority');
  return out;
}
