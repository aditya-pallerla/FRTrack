/**
 * Warning evaluation (false alerts, missed events, lead time).
 *
 * PART A — deterministic false-alert scenarios (the 8 cases from the brief). This checks that the
 *          engine behaves as SPECIFIED; it is not a real-world accuracy measure.
 * PART B — historical replay: hourly ERA5 rainfall for past monsoons, evaluated against the weak
 *          event-level labels in data/manual/flood-labels.json. Environmental evidence only (no
 *          historical ground reports exist). Results describe this prototype on this data only.
 *
 *   npm run eval:warnings   →  server/results/warning-evaluation/results.json
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GroundReport, RainObservation, Settlement, SettlementWarning, WarningLevel } from '../../shared/types.js';
import { assessSettlement } from '../src/engine/assess.js';
import { levelRank } from '../src/engine/levels.js';
import { aggregateCell } from '../src/engine/rainfall.js';
import { applyVerification } from '../src/engine/reports.js';
import { HOUR, MIN } from '../src/engine/time.js';
import { versionWarning } from '../src/engine/versions.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'server', 'results', 'warning-evaluation');

// ── Part A: specification scenarios (synthetic inputs, clearly labelled) ─────
const T = Date.parse('2021-07-22T08:30:00Z');
const cellObs = (vals: (number | null)[], end = T): RainObservation[] => vals.map((v, i) => ({
  cell_id: 'X', lat: 16.7, lng: 74.25, observed_at: new Date(end - (vals.length - 1 - i) * HOUR).toISOString(), interval_min: 60, rainfall_mm: v, source: 'synthetic scenario', mode: 'synthetic_scenario',
}));
const place: Settlement = {
  id: 'SX', name: 'Scenario village', name_mr: null, kind: 'village', lat: 16.7, lng: 74.25, population: null, population_source: null, vulnerable_share: null,
  elevation_m: null, height_above_river_m: 2, distance_to_river_m: 300, terrain_susceptibility: 0.85, road_node: null, road_node_distance_m: null,
  rain_cell: 'X', gauge_id: null, sources: { terrain: { source: 'synthetic scenario' } },
};
let rid = 0;
const rep = (kinds: GroundReport['evidence']['kinds'], dLat = 0): GroundReport => ({
  id: `sr${++rid}`, text: kinds.join(' '), received_at: new Date(T - 15 * MIN).toISOString(), lat: 16.7005 + dLat, lng: 74.2505, location_confidence: 0.85,
  reporter_ref: `sr-${rid}`, verification: 'unverified', mode: 'synthetic_scenario',
  evidence: { kinds, road_blocked: kinds.includes('road_flooded'), people_trapped: kinds.includes('people_trapped') ? -1 : 0, injured: 0, vulnerable_present: false, place_text: null, language: 'en', extractor: 'keyword', extractor_confidence_hint: null },
});
const HEAVY = [0, 0, 0, 0, 0, 0, 23, 23, 23, 23, 23, 23];
const MODERATE = [0, 0, 0, 12, 12, 12];
const run = (vals: (number | null)[], reports: GroundReport[] = [], opts: { end?: number; terrain?: number; previous?: SettlementWarning | null; now?: number } = {}) => {
  const now = opts.now ?? T;
  const s = { ...place, terrain_susceptibility: opts.terrain ?? place.terrain_susceptibility };
  const rain = vals.length ? aggregateCell('X', cellObs(vals, opts.end ?? now), now) : null;
  return assessSettlement({ settlement: s, now, rain, water: null, reports: applyVerification(reports, new Map(), now), closures: [], previous: opts.previous ?? null });
};

function improvementSequence(): WarningLevel[] {
  let prev = versionWarning(null, run(HEAVY));
  const out: WarningLevel[] = [prev.level];
  for (let i = 1; i <= 4; i++) {
    const now = T + i * HOUR;
    prev = versionWarning(prev, run([0, 0, 0, 0, 0, 0], [], { now, end: now, previous: prev }));
    out.push(prev.level);
  }
  return out;
}

const scenarios: { id: number; name: string; expected: string; actual: () => string }[] = [
  { id: 1, name: 'Heavy rainfall, no observed impact', expected: 'WARNING + verification requested (no SEVERE)', actual: () => { const w = run(HEAVY); return `${w.level}${w.verification_requested ? ' + verification requested (no SEVERE)' : ''}`; } },
  { id: 2, name: 'Moderate rainfall + strong terrain susceptibility', expected: 'WATCH', actual: () => run(MODERATE, [], { terrain: 0.95 }).level },
  { id: 3, name: 'Heavy rainfall + corroborating ground reports', expected: 'SEVERE', actual: () => run(HEAVY, [rep(['water_in_homes']), rep(['water_in_homes', 'people_trapped'], 0.001), rep(['road_flooded'], -0.001)]).level },
  { id: 4, name: 'Ground report only', expected: 'WATCH + verification requested', actual: () => { const w = run([0, 0, 0, 0, 0, 0], [rep(['people_trapped', 'rescue_needed'])]); return `${w.level}${w.verification_requested ? ' + verification requested' : ''}`; } },
  { id: 5, name: 'Contradictory ground reports', expected: 'WATCH + verification requested', actual: () => { const w = run(MODERATE, [rep(['water_in_homes']), rep(['water_in_homes'], 0.001), rep(['road_open']), rep(['no_flooding'], 0.001)]); return `${w.level}${w.verification_requested ? ' + verification requested' : ''}`; } },
  { id: 6, name: 'Missing rainfall observation', expected: 'NONE + data gap', actual: () => { const w = run([null, null, null, null, null, null]); return `${w.level}${w.data_gaps.some((g) => g.includes('No rainfall')) ? ' + data gap' : ''}`; } },
  { id: 7, name: 'Stale rainfall observation', expected: 'NONE + DATA STALE', actual: () => { const w = run(HEAVY, [], { end: T - 5 * HOUR }); return `${w.level}${w.data_gaps.some((g) => g.startsWith('DATA STALE')) ? ' + DATA STALE' : ''}`; } },
  { id: 8, name: 'Flood conditions followed by improvement', expected: 'WARNING → WARNING → WARNING → WARNING → NONE', actual: () => improvementSequence().join(' → ') },
];

// ── Part B: historical ───────────────────────────────────────────────────────
interface Labels { label_type: string; events: { id: string; name: string; start: string; end: string; precision: string }[] }

function partB() {
  const histDir = join(ROOT, 'data', 'kolhapur', 'history');
  const settlementsPath = join(ROOT, 'data', 'kolhapur', 'settlements.json');
  if (!existsSync(histDir) || !existsSync(settlementsPath)) return { skipped: 'history rainfall or settlements not built (npm run data:all)' };
  const labels = JSON.parse(readFileSync(join(ROOT, 'data', 'manual', 'flood-labels.json'), 'utf8')) as Labels;
  const settlements = JSON.parse(readFileSync(settlementsPath, 'utf8')) as Settlement[];
  const files = readdirSync(histDir).filter((f) => f.endsWith('.json')).sort();
  const dayAlert = new Map<string, { level: WarningLevel; firstHour: number }>();
  let cellsUsed: string[] = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(histDir, f), 'utf8')) as { meta: { cells: string[] }; observations: RainObservation[] };
    cellsUsed = data.meta.cells;
    // For each cell: the most flood-susceptible real settlement in it (real terrain, from the DEM).
    const reps = data.meta.cells.map((c) => settlements.filter((s) => s.rain_cell === c && s.terrain_susceptibility !== null)
      .sort((a, b) => (b.terrain_susceptibility ?? 0) - (a.terrain_susceptibility ?? 0))[0]).filter(Boolean);
    const times = [...new Set(data.observations.map((o) => Date.parse(o.observed_at)))].sort((a, b) => a - b);
    // Per-cell sorted observations, sliced to the last 100 h for each evaluation (performance only).
    const byCell = new Map<string, { t: number[]; obs: RainObservation[] }>();
    for (const c of data.meta.cells) {
      const obs = data.observations.filter((o) => o.cell_id === c).sort((x, y) => Date.parse(x.observed_at) - Date.parse(y.observed_at));
      byCell.set(c, { t: obs.map((o) => Date.parse(o.observed_at)), obs });
    }
    const lowerBound = (arr: number[], x: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
    const windowObs = (cell: string, t: number) => {
      const c = byCell.get(cell)!;
      return c.obs.slice(lowerBound(c.t, t - 100 * HOUR), lowerBound(c.t, t + 1));
    };
    const prev = new Map<string, SettlementWarning>();
    for (const t of times) {
      if ((t - times[0]) < 96 * HOUR) continue; // need antecedent history
      if (new Date(t).getUTCMinutes() !== 30) continue; // hourly IST steps are :30 UTC
      let best: WarningLevel = 'NONE';
      for (const s of reps) {
        const w = versionWarning(prev.get(s.id) ?? null, assessSettlement({
          settlement: s, now: t, rain: aggregateCell(s.rain_cell!, windowObs(s.rain_cell!, t), t), water: null, reports: [], closures: [], previous: prev.get(s.id) ?? null,
        }));
        prev.set(s.id, w);
        if (levelRank(w.level) > levelRank(best)) best = w.level;
      }
      const day = new Date(t + 5.5 * HOUR).toISOString().slice(0, 10);
      const cur = dayAlert.get(day);
      if (!cur || levelRank(best) > levelRank(cur.level)) dayAlert.set(day, { level: best, firstHour: cur && levelRank(cur.level) >= levelRank('WARNING') ? cur.firstHour : t });
    }
  }
  const days = [...dayAlert.keys()].sort();
  const inEvent = (d: string) => labels.events.find((e) => d >= e.start && d <= e.end);
  const alerting = (d: string) => levelRank(dayAlert.get(d)!.level) >= levelRank('WARNING');
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const d of days) {
    const pos = !!inEvent(d);
    const al = alerting(d);
    if (pos && al) tp++; else if (!pos && al) fp++; else if (!pos && !al) tn++; else fn++;
  }
  // Alert episodes (runs of consecutive alert days) and event-level detection.
  const episodes: { start: string; end: string }[] = [];
  for (const d of days) {
    if (!alerting(d)) continue;
    const last = episodes[episodes.length - 1];
    const prevDay = new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10);
    if (last && last.end === prevDay) last.end = d; else episodes.push({ start: d, end: d });
  }
  const near = (ep: { start: string; end: string }, e: Labels['events'][number]) => {
    const s = new Date(Date.parse(e.start) - 3 * 86_400_000).toISOString().slice(0, 10);
    return ep.end >= s && ep.start <= e.end;
  };
  const falseEpisodes = episodes.filter((ep) => !labels.events.some((e) => near(ep, e)));
  const covered = labels.events.filter((e) => days.includes(e.start));
  const events = covered.map((e) => {
    const alertDays = days.filter((d) => d >= new Date(Date.parse(e.start) - 3 * 86_400_000).toISOString().slice(0, 10) && d <= e.end && alerting(d));
    const first = alertDays[0];
    const leadH = first ? Math.round((Date.parse(`${e.start}T00:00:00+05:30`) - dayAlert.get(first)!.firstHour) / HOUR) : null;
    return { id: e.id, name: e.name, detected: !!first, first_alert: first ? new Date(dayAlert.get(first)!.firstHour).toISOString() : null, lead_time_h_vs_labelled_start: leadH };
  });
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  return {
    dataset: `Open-Meteo ERA5 (0.25°) hourly rainfall, ${files.map((f) => f.slice(9, 13)).join(', ')} (June–September)`,
    source: 'Open-Meteo Historical Weather API (ERA5 reanalysis, CC BY 4.0)',
    period: `${days[0]} → ${days[days.length - 1]}`,
    label_type: labels.label_type,
    cells: cellsUsed,
    method: 'Engine run hourly on environmental evidence only (no historical ground reports or river levels) for the most flood-susceptible real settlement in each evaluated rain cell; a day is an ALERT day if any evaluation reached WARNING or SEVERE.',
    limitations: [
      'Labels are weak: only major documented floods are labelled, with approximate dates; smaller real floods count as "no flood", inflating false alerts.',
      'ERA5 (~28 km grid) smooths and under-estimates extreme local rainfall over the Western Ghats.',
      'No historical ground reports or river levels are used, so the full evidence fusion is not evaluated here.',
      `Only ${cellsUsed.length} rain cells near the district centre are evaluated.`,
      'Thresholds are prototype values; these results do NOT represent real-world deployment accuracy.',
    ],
    day_level: { tp, fp, tn, fn, precision, recall, false_alert_rate_days: fp + tp ? fp / (fp + tp) : null, missed_event_day_rate: tp + fn ? fn / (tp + fn) : null },
    event_level: { labelled_events_in_period: covered.length, detected: events.filter((e) => e.detected).length, missed: events.filter((e) => !e.detected).length, alert_episodes: episodes.length, false_alert_episodes: falseEpisodes.length, false_alert_rate_episodes: episodes.length ? falseEpisodes.length / episodes.length : null, events },
    false_alert_episodes: falseEpisodes,
  };
}

function main() {
  const a = scenarios.map((s) => { const actual = s.actual(); return { id: s.id, name: s.name, expected: s.expected, actual, pass: actual === s.expected }; });
  console.log('\nPART A — deterministic false-alert scenarios (specification conformance, synthetic inputs)');
  console.table(a.map((r) => ({ '#': r.id, scenario: r.name, expected: r.expected, actual: r.actual, result: r.pass ? 'PASS' : 'FAIL' })));
  const b = partB();
  console.log('\nPART B — historical replay against weak labels');
  if ('skipped' in b) console.log(`  skipped: ${b.skipped}`);
  else {
    console.log(`  DATASET:     ${b.dataset}\n  SOURCE:      ${b.source}\n  PERIOD:      ${b.period}\n  LABEL TYPE:  ${b.label_type}`);
    console.log('  LIMITATIONS:'); b.limitations.forEach((l) => console.log(`   - ${l}`));
    const f = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
    console.table({
      'Day level': { TP: b.day_level.tp, FP: b.day_level.fp, TN: b.day_level.tn, FN: b.day_level.fn, Precision: f(b.day_level.precision), Recall: f(b.day_level.recall), 'False-alert rate': f(b.day_level.false_alert_rate_days), 'Missed-event rate': f(b.day_level.missed_event_day_rate) },
    });
    console.table(b.event_level.events);
    console.log(`  Alert episodes: ${b.event_level.alert_episodes}, false-alert episodes: ${b.event_level.false_alert_episodes} (${f(b.event_level.false_alert_rate_episodes)})`);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ generated_at: new Date().toISOString(), part_a_specification_scenarios: a, part_b_historical: b }, null, 2));
  console.log(`\nWrote server/results/warning-evaluation/results.json`);
  if (a.some((r) => !r.pass)) process.exitCode = 1;
}

main();
