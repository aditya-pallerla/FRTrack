/**
 * Flood engine rules: rainfall aggregation, levels, confidence ≠ risk, false-alert handling,
 * ground-report corroboration and conflict, staleness, hysteresis, versioning and mode separation.
 */
import type { GroundReport, RiverGauge, SettlementWarning } from '../../shared/types.js';
import { assessSettlement, type WaterInput } from '../src/engine/assess.js';
import { RAIN_THRESHOLDS } from '../src/engine/config.js';
import { buildWorld, evaluate, type Inputs } from '../src/engine/evaluate.js';
import { severityIndex } from '../src/engine/levels.js';
import { prioritise } from '../src/engine/priority.js';
import { aggregateCell } from '../src/engine/rainfall.js';
import { applyVerification } from '../src/engine/reports.js';
import { HOUR, MIN } from '../src/engine/time.js';
import { versionWarning } from '../src/engine/versions.js';
import { BASE, T0, evidence, grid, hourly, report, settlement } from './fixtures.js';
import { assert, eq, runStandalone, test } from './harness.js';

const HEAVY = [0, 0, 0, 0, 0, 0, 22, 22, 22, 22, 22, 22]; // 6 h = 132 mm (≥ prototype severe 130)
const MODERATE = [0, 0, 0, 12, 12, 12];                    // 3 h = 36 mm (just over WATCH)
const DRY = [0, 0, 0, 0, 0, 0];

const GAUGE: RiverGauge = {
  id: 'G1', name: 'Test gauge', river: 'Test river', lat: 16.7, lng: 74.25, unit: 'ft',
  warning_level: 39, danger_level: 43, levels_source: 'fixture', levels_verified: false,
};

function assess(opts: {
  rain?: (number | null)[]; rainEnd?: number; reports?: GroundReport[]; previous?: SettlementWarning | null;
  water?: WaterInput | null; gauge?: boolean; terrain?: number | null; now?: number;
}) {
  const now = opts.now ?? T0;
  const s = settlement({ terrain_susceptibility: opts.terrain === undefined ? 0.9 : opts.terrain, gauge_id: opts.gauge ? 'G1' : null });
  const rain = aggregateCell('C1', hourly(opts.rain ?? DRY, opts.rainEnd ?? now), now);
  return assessSettlement({ settlement: s, now, rain, water: opts.water ?? null, reports: opts.reports ?? [], closures: [], previous: opts.previous ?? null });
}

const corroborated = (rs: GroundReport[]) => applyVerification(rs, new Map(), T0);

// ── Rainfall ──────────────────────────────────────────────────────────────────
test('rainfall windows sum the right hours and report missing intervals', () => {
  const r = aggregateCell('C1', hourly([1, 2, 3, 4, 5, 6]), T0);
  eq(r.rain_1h.mm, 6, '1 h');
  eq(r.rain_3h.mm, 15, '3 h');
  eq(r.rain_6h.mm, 21, '6 h');
  eq(r.rain_24h.mm, 21, '24 h');
  eq(r.rain_24h.missing, 18, '24 h missing intervals');
  eq(r.trend_3h_mm, 9, 'trend (15 − 6)');
});

test('observations after the engine clock are never used (no look-ahead)', () => {
  const obs = [...hourly([5, 5]), ...hourly([100], T0 + HOUR)];
  eq(aggregateCell('C1', obs, T0).rain_1h.mm, 5, '1 h must ignore the future hour');
});

test('missing values are not treated as zero', () => {
  const r = aggregateCell('C1', hourly([null, null, null]), T0);
  eq(r.rain_3h.mm, null, 'all-missing window is null, not 0');
  eq(r.latest_observed_at, null, 'freshness ignores empty observations');
});

test('severity index boundaries', () => {
  const t = RAIN_THRESHOLDS.rain_24h;
  eq(severityIndex(0, t), 0, 'zero');
  eq(Math.round(severityIndex(t.watch, t) * 1000), 333, 'watch = ⅓');
  eq(Math.round(severityIndex(t.warning, t) * 1000), 667, 'warning = ⅔');
  eq(severityIndex(t.severe, t), 1, 'severe = 1');
});

// ── Levels and the false-alert check ────────────────────────────────────────
test('dry conditions → no warning', () => {
  eq(assess({ rain: DRY }).level, 'NONE', 'level');
});

test('FALSE ALERT: heavy rain alone (no corroboration) stays WARNING and requests verification', () => {
  const w = assess({ rain: HEAVY });
  eq(w.initial_level, 'WARNING', 'initial level');
  eq(w.level, 'WARNING', 'must not escalate to SEVERE on rain alone');
  assert(w.verification_requested, 'verification must be requested');
  assert(w.false_alert_notes.some((n) => n.includes('SEVERE withheld')), 'explains why SEVERE was withheld');
});

test('heavy rain on ground that is not susceptible stays at WATCH', () => {
  eq(assess({ rain: HEAVY, terrain: 0.1 }).level, 'WATCH', 'level');
});

test('extreme rain + river above danger level → SEVERE', () => {
  const water: WaterInput = {
    gauge: GAUGE, previous: { gauge_id: 'G1', observed_at: new Date(T0 - HOUR).toISOString(), level: 42, unit: 'ft', source: 'fixture', mode: 'replay' },
    latest: { gauge_id: 'G1', observed_at: new Date(T0).toISOString(), level: 44, unit: 'ft', source: 'fixture', mode: 'replay' },
  };
  const w = assess({ rain: HEAVY, gauge: true, water });
  eq(w.level, 'SEVERE', 'level');
  assert(w.confidence.value >= 0.6, 'confidence ≥ 60%');
});

test('ONE unverified report alone can never create SEVERE (or even WARNING)', () => {
  const w = assess({ rain: DRY, reports: [report({ evidence: evidence({ kinds: ['water_in_homes', 'people_trapped'], people_trapped: -1 }) })] });
  eq(w.level, 'WATCH', 'ground-only evidence is capped at WATCH');
  assert(w.verification_requested, 'verification requested');
});

test('heavy rain + one unverified report is still not SEVERE', () => {
  eq(assess({ rain: HEAVY, reports: [report()] }).level, 'WARNING', 'level');
});

test('moderate rain + 3 independent corroborating reports → escalates to WARNING', () => {
  const reps = corroborated([report(), report({ lat: 16.7010 }), report({ lng: 74.2512 })]);
  assert(reps.every((r) => r.verification === 'corroborated'), 'reports from 3 reporters within 800 m are corroborated');
  const w = assess({ rain: MODERATE, reports: reps });
  eq(w.initial_level, 'WATCH', 'environment alone = WATCH');
  eq(w.level, 'WARNING', 'ground evidence escalates');
});

test('NO DOUBLE COUNTING: a road closure derived from the same reports is not a second evidence class', () => {
  const reps = corroborated([report({ evidence: evidence({ kinds: ['road_flooded', 'water_in_homes'], road_blocked: true }) }), report({ lat: 16.7010, evidence: evidence({ kinds: ['road_flooded'], road_blocked: true }) })]);
  const s = settlement();
  const rain = aggregateCell('C1', hourly(MODERATE), T0);
  const fromReports = assessSettlement({ settlement: s, now: T0, rain, water: null, reports: reps, previous: null,
    closures: [{ segment_id: 'x', name: 'Road x', reason: 'corroborated ground report', origin: `ground report ${reps[0].id}` }] });
  eq(fromReports.level, 'WARNING', 'reports + their own derived closure must not reach SEVERE');
  const independent = assessSettlement({ settlement: s, now: T0, rain, water: null, reports: reps, previous: null,
    closures: [{ segment_id: 'x', name: 'Road x', reason: 'confirmed by field unit', origin: 'coordinator: coordinator' }] });
  eq(independent.level, 'SEVERE', 'an independently confirmed closure is a second strong class');
});

test('conflicting reports block escalation and request verification', () => {
  const open = evidence({ kinds: ['road_open', 'no_flooding'] });
  const reps = corroborated([report(), report({ lat: 16.7010 }), report({ evidence: open }), report({ evidence: open, lat: 16.7010 })]);
  const w = assess({ rain: MODERATE, reports: reps });
  eq(w.level, 'WATCH', 'no escalation while reports conflict');
  assert(w.verification_requested, 'verification requested');
  assert(w.confidence.consistency < 0.75, 'consistency reduced by conflict');
});

test('a coordinator-disputed report carries no weight', () => {
  const r = report();
  const reps = applyVerification([r], new Map([[r.id, 'disputed' as const]]), T0);
  eq(assess({ rain: DRY, reports: reps }).level, 'NONE', 'disputed report ignored');
});

test('stale rainfall cannot drive a warning and is flagged', () => {
  const w = assess({ rain: HEAVY, rainEnd: T0 - 4 * HOUR });
  eq(w.level, 'NONE', 'stale rain does not escalate');
  assert(w.data_gaps.some((g) => g.startsWith('DATA STALE')), 'DATA STALE gap shown');
});

test('missing rainfall is reported as a data gap', () => {
  const w = assessSettlement({ settlement: settlement(), now: T0, rain: null, water: null, reports: [], closures: [], previous: null });
  assert(w.data_gaps.some((g) => g.includes('No rainfall')), 'gap listed');
});

test('missing river level is reported as a data gap', () => {
  assert(assess({ rain: DRY, gauge: true }).data_gaps.includes('No river-level observation available.'), 'gap listed');
});

// ── Confidence is not risk ──────────────────────────────────────────────────
test('confidence is independent of risk (same risk, different evidence quality)', () => {
  const a = assess({ rain: HEAVY });
  const b = assess({ rain: HEAVY, gauge: true }); // expected gauge reading is missing → lower coverage
  eq(a.risk, b.risk, 'risk identical');
  assert(b.confidence.value < a.confidence.value, `confidence must differ (${a.confidence.value} vs ${b.confidence.value})`);
});

// ── Hysteresis and versioning ───────────────────────────────────────────────
test('improvement must be sustained for 3 hours before a downgrade', () => {
  let prev = versionWarning(null, assess({ rain: HEAVY }));
  eq(prev.level, 'WARNING', 'start');
  const levels: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const now = T0 + i * 90 * MIN; // improvement first seen at +90 min, then +180, +270
    const cur = versionWarning(prev, assess({ rain: DRY, rainEnd: now, now, previous: prev }));
    levels.push(cur.level);
    prev = cur;
  }
  eq(levels.join(','), 'WARNING,WARNING,NONE', 'held at 0 h and 1.5 h of improvement, downgraded at 3 h');
});

test('no new evidence is not improvement: no downgrade while rain is still rising', () => {
  let prev = versionWarning(null, assess({ rain: HEAVY }));
  const RISING = [0, 0, 0, 2, 4, 6]; // light but increasing rain: lower candidate, yet no sign of improvement
  for (let i = 1; i <= 3; i++) {
    const now = T0 + i * 90 * MIN;
    prev = versionWarning(prev, assess({ rain: RISING, rainEnd: now, now, previous: prev }));
  }
  eq(prev.level, 'WARNING', 'held beyond 3 h because nothing indicates improvement');
  assert(prev.verification_requested, 're-verification requested');
});

test('re-evaluating at the same moment never advances a pending downgrade', () => {
  let prev = versionWarning(null, assess({ rain: HEAVY }));
  const now = T0 + 90 * MIN;
  for (let i = 0; i < 10; i++) prev = versionWarning(prev, assess({ rain: DRY, rainEnd: now, now, previous: prev }));
  eq(prev.level, 'WARNING', 'ten re-evaluations at one instant must not count as sustained improvement');
});

test('every level change creates a new version with a reason', () => {
  const v1 = versionWarning(null, assess({ rain: MODERATE }));
  eq(v1.version, 1, 'first version');
  const v2 = versionWarning(v1, assess({ rain: HEAVY, previous: v1 }));
  eq(v2.version, 2, 'second version');
  assert(!!v2.reason_for_change?.includes('Escalated WATCH → WARNING'), `reason: ${v2.reason_for_change}`);
});

// ── Priority ─────────────────────────────────────────────────────────────────
test('priority: unknown population is flagged; no-warning settlements are capped', () => {
  const s = settlement({ population: null });
  const w = assess({ rain: DRY });
  const [p] = prioritise([{ settlement: s, warning: w, access: undefined, reports: [], maxPopulation: 10000 }], new Map());
  assert(p.unknowns.includes('population'), 'population listed as unknown');
  assert(p.score <= 30, `capped at 30, got ${p.score}`);
});

test('priority explains why it changed', () => {
  const s = settlement();
  const acc = (status: 'REACHABLE' | 'CUT_OFF') => ({ settlement_id: s.id, status, base_id: null, route: null, baseline_duration_s: null, eta_delta_min: null, blocked_on_baseline: [], note: null });
  const w = assess({ rain: HEAVY });
  const [p1] = prioritise([{ settlement: s, warning: w, access: acc('REACHABLE'), reports: [], maxPopulation: 10000 }], new Map());
  const [p2] = prioritise([{ settlement: s, warning: w, access: acc('CUT_OFF'), reports: [], maxPopulation: 10000 }], new Map([[s.id, p1]]));
  assert(p2.score > p1.score, 'cut-off raises priority');
  assert(p2.changes.some((c) => c.includes('REACHABLE → CUT OFF')), `changes: ${p2.changes.join('; ')}`);
});

// ── Live / replay separation ────────────────────────────────────────────────
function inputs(mode: 'live' | 'replay', over: Partial<Inputs> = {}): Inputs {
  return { mode, replay: null, rain: [], water: [], reports: [], decisions: new Map(), roadEvents: [], units: [], assignments: [], rejected: new Set(), ...over };
}

test('LIVE evaluation never uses replay observations', () => {
  const world = buildWorld([settlement()], grid(), [BASE], []);
  const sit = evaluate(world, inputs('live', { rain: hourly(HEAVY, T0, 'C1', 'replay') }), T0, null);
  eq(sit.warnings[0].level, 'NONE', 'replay rain must not affect live');
  assert(sit.warnings[0].evidence.every((e) => e.mode !== 'replay'), 'no replay evidence in live view');
  eq(sit.freshness.rain_age_min, null, 'no rain freshness from replay data');
});

test('REPLAY evaluation never uses live observations, and keeps original timestamps', () => {
  const world = buildWorld([settlement()], grid(), [BASE], []);
  const sit = evaluate(world, inputs('replay', { rain: [...hourly(HEAVY, T0, 'C1', 'live')] }), T0, null);
  eq(sit.warnings[0].level, 'NONE', 'live rain must not affect replay');
  const sit2 = evaluate(world, inputs('replay', { rain: hourly(HEAVY, T0, 'C1', 'replay') }), T0, null);
  const ev = sit2.warnings[0].evidence.find((e) => e.kind === 'rain_1h')!;
  eq(ev.observed_at, new Date(T0).toISOString(), 'original observation time preserved');
});

await runStandalone('Flood engine');
