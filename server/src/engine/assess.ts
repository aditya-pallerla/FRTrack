/**
 * Flood assessment for one settlement at the engine clock.
 *
 * Pipeline (matches the agreed flow):
 *   1. Environmental evidence  → INITIAL level   (rainfall, antecedent rain, terrain, river level)
 *   2. Ground reports           → supporting / conflicting weight
 *   3. Risk and confidence      → two separate numbers
 *   4. False-alert check        → strong evidence escalates; weak evidence requests verification
 *   5. Hysteresis               → downgrades only after sustained improvement
 *
 * Deterministic and explainable: the same inputs always give the same output, and every rule that
 * fired is written into evidence / notes.
 */
import type {
  ConfidenceBreakdown, EvidenceItem, GroundReport, RiverGauge, Settlement, SettlementWarning,
  WarningLevel, WaterLevelObservation,
} from '../../../shared/types.js';
import {
  CONFIDENCE_WEIGHTS, FALSE_ALERT, FRESHNESS, GROUND, GROUND_RISK_WEIGHT, HAZARD_WEIGHTS, RAIN_THRESHOLDS,
  RAIN_WINDOWS, TERRAIN, TERRAIN_FACTOR, UNKNOWN_NEUTRAL, type RainWindow,
} from './config.js';
import { clamp01, haversineM } from './geo.js';
import { freshnessFactor, levelRank, severityIndex } from './levels.js';
import type { CellRainfall } from './rainfall.js';
import { MIN, ageMin, ms } from './time.js';

export interface WaterInput {
  gauge: RiverGauge;
  latest: WaterLevelObservation | null;
  previous: WaterLevelObservation | null;
}

export interface ConfirmedClosure {
  segment_id: string;
  name: string | null;
  reason: string;
  origin: string;
  /** Data mode of the closure record (defaults to synthetic_scenario when unknown). */
  mode?: EvidenceItem['mode'];
  since?: string | null;
}

export interface AssessInput {
  settlement: Settlement;
  now: number;
  rain: CellRainfall | null;
  water: WaterInput | null;
  /** Reports already restricted to the active mode; this function applies radius and time window. */
  reports: GroundReport[];
  /** Confirmed road closures near this settlement (verified report, coordinator or documented record). */
  closures: ConfirmedClosure[];
  previous: SettlementWarning | null;
}

const SUPPORT_KINDS = new Set([
  'water_in_homes', 'road_flooded', 'bridge_submerged', 'people_trapped', 'rescue_needed',
  'water_rising', 'vehicles_cannot_pass', 'shelter_inaccessible',
]);
const CONFLICT_KINDS = new Set(['road_open', 'no_flooding']);

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Reports attributed to a settlement: inside the radius and inside the time window, never from the future. */
export function reportsForSettlement(s: Settlement, reports: GroundReport[], now: number): GroundReport[] {
  return reports.filter((r) => {
    const t = ms(r.received_at);
    return t <= now && now - t <= GROUND.window_min * MIN
      && haversineM({ lat: s.lat, lng: s.lng }, { lat: r.lat, lng: r.lng }) <= GROUND.radius_m;
  });
}

export function reportStance(r: GroundReport): 'support' | 'conflict' | 'neutral' {
  if (r.evidence.kinds.some((k) => SUPPORT_KINDS.has(k)) || r.evidence.road_blocked || r.evidence.people_trapped !== 0) return 'support';
  if (r.evidence.kinds.some((k) => CONFLICT_KINDS.has(k))) return 'conflict';
  return 'neutral';
}

export function reportWeight(r: GroundReport, now: number): number {
  const fresh = freshnessFactor(ageMin(r.received_at, now), FRESHNESS.report);
  return GROUND.weight[r.verification] * clamp01(r.location_confidence) * Math.max(0.5, fresh);
}

export function assessSettlement(input: AssessInput): SettlementWarning {
  const { settlement: s, now, rain, water, closures, previous } = input;
  const evidence: EvidenceItem[] = [];
  const gaps: string[] = [];
  const notes: string[] = [];

  // ── 1a. Rainfall ────────────────────────────────────────────────────────────
  const rainAge = rain ? ageMin(rain.latest_observed_at, now) : null;
  const rainStale = rainAge === null || rainAge > FRESHNESS.rain.stale;
  let rainIdx = 0;
  let rainAvailable = false;
  if (!rain || rain.latest_observed_at === null) {
    gaps.push('No rainfall observation available for this settlement.');
  } else {
    if (rainStale) gaps.push(`DATA STALE: latest rainfall observation is ${rainAge} min old.`);
    for (const key of Object.keys(RAIN_WINDOWS) as RainWindow[]) {
      const win = rain[key];
      const th = RAIN_THRESHOLDS[key];
      if (win.mm === null) { gaps.push(`No ${RAIN_WINDOWS[key].label.toLowerCase()} value (all ${win.expected} intervals missing).`); continue; }
      rainAvailable = true;
      if (win.missing > 0) gaps.push(`${RAIN_WINDOWS[key].label}: ${win.missing} of ${win.expected} intervals missing; total may be understated.`);
      const idx = severityIndex(win.mm, th);
      rainIdx = Math.max(rainIdx, idx);
      evidence.push({
        kind: key, label: RAIN_WINDOWS[key].label, value: win.mm, unit: 'mm', threshold: th.watch,
        threshold_source: th.note, supports: idx >= 1 / 3, observed_at: rain.latest_observed_at,
        age_min: rainAge, stale: rainStale, source: rain.source ?? 'unknown', mode: rain.mode ?? 'replay',
      });
    }
  }
  // Stale rain is shown but cannot drive escalation.
  const rainDriver = rainStale ? 0 : rainIdx;

  let anteIdx = 0;
  let anteAvailable = false;
  if (rain && rain.antecedent_72h.mm !== null) {
    anteAvailable = true;
    anteIdx = severityIndex(rain.antecedent_72h.mm, RAIN_THRESHOLDS.antecedent_72h);
    evidence.push({
      kind: 'antecedent_72h', label: 'Rain in the 72 h before (wet ground)', value: rain.antecedent_72h.mm, unit: 'mm',
      threshold: RAIN_THRESHOLDS.antecedent_72h.watch, threshold_source: RAIN_THRESHOLDS.antecedent_72h.note,
      supports: anteIdx >= 1 / 3, observed_at: rain.latest_observed_at, age_min: rainAge, stale: rainStale,
      source: rain.source ?? 'unknown', mode: rain.mode ?? 'replay',
    });
  }
  if (rain?.trend_3h_mm != null) {
    evidence.push({
      kind: 'rain_trend', label: 'Rainfall trend (last 3 h vs 3 h before)', value: rain.trend_3h_mm, unit: 'mm',
      supports: rain.trend_3h_mm > 0, observed_at: rain.latest_observed_at, age_min: rainAge, stale: rainStale,
      source: rain.source ?? 'unknown', mode: rain.mode ?? 'replay',
    });
  }

  // ── 1b. Terrain (static) ────────────────────────────────────────────────────
  const terrain = s.terrain_susceptibility;
  const terrainSusceptible = terrain !== null && terrain >= TERRAIN.susceptible;
  if (terrain === null) {
    gaps.push('Terrain susceptibility unknown for this settlement.');
  } else {
    evidence.push({
      kind: 'terrain', label: 'Terrain susceptibility (low ground near river)', value: terrain,
      threshold: TERRAIN.susceptible, threshold_source: TERRAIN.note, supports: terrainSusceptible,
      observed_at: null, age_min: null, stale: false, source: s.sources.terrain?.source ?? 'DEM', mode: 'static',
    });
  }

  // ── 1c. River level ─────────────────────────────────────────────────────────
  let waterIdx = 0;
  let waterAvailable = false;
  let waterAge: number | null = null;
  const waterExpected = !!s.gauge_id;
  if (waterExpected) {
    if (!water?.latest) {
      gaps.push('No river-level observation available.');
    } else if (water.gauge.warning_level === null || water.gauge.danger_level === null) {
      gaps.push(`River level at ${water.gauge.name} is known but warning/danger reference levels are not.`);
    } else {
      waterAge = ageMin(water.latest.observed_at, now);
      const waterStale = waterAge === null || waterAge > FRESHNESS.water.stale;
      const { warning_level: wl, danger_level: dl } = water.gauge;
      const lvl = water.latest.level;
      const idx = riverIndex(lvl, wl, dl);
      waterAvailable = !waterStale;
      if (waterStale) gaps.push(`DATA STALE: river level is ${waterAge} min old.`);
      else waterIdx = idx;
      const rising = water.previous ? lvl - water.previous.level : null;
      evidence.push({
        kind: 'water_level',
        label: `${water.gauge.name} river level${rising !== null ? ` (${rising >= 0 ? '+' : ''}${round2(rising)} ${water.gauge.unit} since previous)` : ''}`,
        value: lvl, unit: water.gauge.unit, threshold: wl,
        threshold_source: `Warning ${wl} / danger ${dl} ${water.gauge.unit} — ${water.gauge.levels_source}${water.gauge.levels_verified ? '' : ' (reference not yet verified)'}`,
        supports: idx >= 1 / 3, observed_at: water.latest.observed_at, age_min: waterAge, stale: waterStale,
        source: water.latest.source, mode: water.latest.mode,
      });
    }
  }

  // ── 1d. Initial (environmental) level ───────────────────────────────────────
  const driver = Math.max(rainDriver, waterIdx);
  let initial: WarningLevel = 'NONE';
  if (driver >= 1 / 3 || (anteIdx >= 2 / 3 && rainDriver >= 0.2)) initial = 'WATCH';
  if (driver >= 2 / 3) {
    // Heavy rain on ground that is known NOT to be susceptible, with no river signal, stays at WATCH.
    const confirmed = terrain === null || terrainSusceptible || waterIdx >= 2 / 3 || anteIdx >= 2 / 3;
    if (confirmed) initial = 'WARNING';
    else notes.push('Heavy rain, but terrain here is not flood-susceptible and there is no river signal: kept at WATCH.');
  }
  const envSevereCandidate = driver >= 1 && (terrainSusceptible || waterIdx >= 1);

  // ── 2. Ground reports ───────────────────────────────────────────────────────
  const mine = reportsForSettlement(s, input.reports, now);
  let support = 0;
  let conflict = 0;
  const supporters = new Set<string>();
  for (const r of mine) {
    const stance = reportStance(r);
    const w = reportWeight(r, now);
    if (stance === 'support') { support += w; if (w > 0) supporters.add(r.reporter_ref); }
    else if (stance === 'conflict') conflict += w;
  }
  const supportCount = mine.filter((r) => reportStance(r) === 'support' && r.verification !== 'disputed').length;
  const conflictCount = mine.filter((r) => reportStance(r) === 'conflict' && r.verification !== 'disputed').length;
  const contested = conflict > 0 && conflict >= 0.5 * support;
  const strongGround = support >= GROUND.strong_support && supporters.size >= 2 && !contested;
  const groundIdx = clamp01(support / GROUND.strong_support);
  const reportAge = mine.length ? Math.min(...mine.map((r) => ageMin(r.received_at, now) ?? Infinity)) : null;
  if (!mine.length) gaps.push(`No ground reports for this settlement in the last ${GROUND.window_min / 60} hours.`);
  if (supportCount) {
    evidence.push({
      kind: 'ground_support', label: `${supportCount} ground report${supportCount > 1 ? 's' : ''} indicating flooding`,
      value: round2(support), threshold: GROUND.strong_support, threshold_source: 'Prototype: weighted by verification, location confidence and age',
      supports: true, observed_at: latestReportTime(mine, 'support'), age_min: reportAge, stale: false,
      source: describeVerification(mine.filter((r) => reportStance(r) === 'support')), mode: modeOf(mine),
    });
  }
  if (conflictCount) {
    evidence.push({
      kind: 'ground_conflict', label: `${conflictCount} report${conflictCount > 1 ? 's' : ''} saying roads are open / no flooding`,
      value: round2(conflict), supports: false, observed_at: latestReportTime(mine, 'conflict'), age_min: reportAge, stale: false,
      source: describeVerification(mine.filter((r) => reportStance(r) === 'conflict')), mode: modeOf(mine),
    });
  }
  for (const c of closures) {
    evidence.push({
      kind: 'road_blocked', label: `Road blocked: ${c.name ?? c.segment_id}`, value: c.reason, supports: true,
      observed_at: c.since ?? null, age_min: c.since ? ageMin(c.since, now) : null, stale: false, source: c.origin, mode: c.mode ?? 'synthetic_scenario',
    });
  }
  // A closure derived from the same ground reports is NOT independent evidence (no double counting):
  // only closures from a coordinator, a documented record or a scenario event count as a separate class.
  const roadStrong = closures.some((c) => !c.origin.startsWith('ground report'));

  // ── 3. Candidate level from all evidence ────────────────────────────────────
  let candidate: WarningLevel = initial;
  let verificationRequested = false;
  if (initial === 'NONE' && support > 0) {
    candidate = 'WATCH';
    verificationRequested = true;
    notes.push('Ground reports without environmental support: limited to WATCH until verified or backed by rain/river data.');
  } else if (initial === 'WATCH') {
    if (strongGround || (roadStrong && support > 0)) {
      candidate = 'WARNING';
      notes.push('Moderate environmental signal confirmed by independent ground evidence: escalated to WARNING.');
    } else if (support > 0) {
      verificationRequested = true;
      notes.push('Ground reports received but not yet strong enough to escalate: verification requested.');
    }
  }
  if (contested) {
    if (levelRank(candidate) > levelRank(initial)) candidate = initial;
    verificationRequested = true;
    notes.push('Conflicting ground reports (flooding vs. roads open): no escalation from reports until verified.');
  }

  // ── 4. Confidence (independent of risk) ─────────────────────────────────────
  const hazardDirection = levelRank(candidate) >= levelRank('WATCH');
  const classes: { name: string; available: boolean; indicates: boolean }[] = [
    { name: 'rain', available: rainAvailable && !rainStale, indicates: rainDriver >= 1 / 3 },
    { name: 'terrain', available: terrain !== null, indicates: terrainSusceptible },
    { name: 'water', available: waterAvailable, indicates: waterIdx >= 1 / 3 },
    { name: 'ground', available: mine.length > 0, indicates: support > conflict },
    { name: 'road', available: roadStrong, indicates: roadStrong },
  ];
  const agreeing = classes.filter((c) => c.available && c.indicates === hazardDirection).length;
  const independence = clamp01(agreeing / 3);
  const freshParts: number[] = [];
  if (rainAvailable) freshParts.push(freshnessFactor(rainAge, FRESHNESS.rain));
  if (waterExpected && water?.latest) freshParts.push(freshnessFactor(waterAge, FRESHNESS.water));
  if (mine.length) freshParts.push(freshnessFactor(reportAge, FRESHNESS.report));
  const freshness = freshParts.length ? freshParts.reduce((a, b) => a + b, 0) / freshParts.length : 0;
  let consistency = support + conflict > 0 ? 1 - conflict / (support + conflict) : 1;
  if (!hazardDirection && support > 0) consistency = Math.min(consistency, 1 - clamp01(support / (support + 1)));
  if (support > 0 && driver < 1 / 3) consistency *= 0.8; // reports without environmental support
  const expected = 3 + (waterExpected ? 1 : 0); // rain, terrain, roads (+ gauge)
  const covered = (rainAvailable && !rainStale ? 1 : 0) + (terrain !== null ? 1 : 0) + 1 + (waterExpected && waterAvailable ? 1 : 0);
  const coverage = covered / expected;
  const location = mine.length ? mine.reduce((a, r) => a + clamp01(r.location_confidence), 0) / mine.length : UNKNOWN_NEUTRAL;
  const confValue = CONFIDENCE_WEIGHTS.independence * independence + CONFIDENCE_WEIGHTS.freshness * freshness
    + CONFIDENCE_WEIGHTS.consistency * consistency + CONFIDENCE_WEIGHTS.coverage * coverage + CONFIDENCE_WEIGHTS.location * location;
  const confidence: ConfidenceBreakdown = {
    value: round2(confValue), independence: round2(independence), freshness: round2(freshness),
    consistency: round2(consistency), coverage: round2(coverage), location: round2(location),
  };

  // ── 5. False-alert check for SEVERE ─────────────────────────────────────────
  const strongClasses = [
    rainDriver >= 1 && 'extreme rainfall',
    waterIdx >= 1 && 'river at/above danger level',
    strongGround && 'independent corroborated ground reports',
    roadStrong && 'confirmed road closure',
  ].filter(Boolean) as string[];
  if (levelRank(candidate) >= levelRank('WARNING') && (envSevereCandidate || strongClasses.length >= 1)) {
    const enoughClasses = strongClasses.length >= FALSE_ALERT.severe_strong_classes;
    const enoughConfidence = confidence.value >= FALSE_ALERT.severe_min_confidence;
    if (enoughClasses && enoughConfidence && !contested) {
      candidate = 'SEVERE';
      notes.push(`SEVERE: ${strongClasses.join(' + ')} (confidence ${Math.round(confidence.value * 100)}%).`);
    } else if (envSevereCandidate || strongClasses.length >= 1) {
      verificationRequested = true;
      const why = !enoughClasses
        ? `only ${strongClasses.length || 'no'} strong evidence class${strongClasses.length === 1 ? '' : 'es'} (${strongClasses.join(', ') || 'none'}); SEVERE needs ${FALSE_ALERT.severe_strong_classes}`
        : contested ? 'reports conflict' : `confidence ${Math.round(confidence.value * 100)}% is below ${FALSE_ALERT.severe_min_confidence * 100}%`;
      notes.push(`False-alert check: SEVERE withheld — ${why}. Verification requested.`);
    }
  }
  // A single unverified report can never, on its own, produce SEVERE (enforced by the rules above:
  // SEVERE needs WARNING-level support first and ≥2 independent strong classes). Asserted in tests.

  // ── 6. Hysteresis (time-based, so re-evaluating at the same moment never advances it) ─────
  let level = candidate;
  let pendingSince: string | null = null;
  if (previous && levelRank(candidate) < levelRank(previous.level)) {
    const since = previous.downgrade_pending_since ?? new Date(now).toISOString();
    const heldMin = Math.max(0, Math.round((now - ms(since)) / MIN));
    // No new evidence is not evidence of improvement: a downgrade also needs an improvement signal —
    // rain easing, reports that water receded / roads are open, or a closure reopening.
    const prevClosures = previous.evidence.filter((e) => e.kind === 'road_blocked').length;
    const improving = (rain?.trend_3h_mm != null && rain.trend_3h_mm <= 0) || conflict > 0 || closures.length < prevClosures;
    if (heldMin >= FALSE_ALERT.downgrade_after_min && !improving) {
      level = previous.level;
      pendingSince = since;
      verificationRequested = true;
      notes.push(`Evidence is ageing but there is no sign of improvement (rain not easing, no "receded" reports, no roads reopened): level held at ${previous.level}; re-verification requested.`);
    } else if (heldMin < FALSE_ALERT.downgrade_after_min) {
      level = previous.level;
      pendingSince = since;
      notes.push(`Improvement observed for ${heldMin} min: level held at ${previous.level} until it is sustained for ${FALSE_ALERT.downgrade_after_min / 60} h.`);
    } else {
      notes.push(`Improvement sustained for ${Math.round(heldMin / 6) / 10} h: downgraded ${previous.level} → ${candidate}.`);
    }
  }

  // ── 7. Risk (severity of expected impact) ───────────────────────────────────
  const drivers: [number, number][] = [];
  if (rainAvailable && !rainStale) drivers.push([HAZARD_WEIGHTS.rain, rainIdx]);
  if (anteAvailable && !rainStale) drivers.push([HAZARD_WEIGHTS.antecedent, anteIdx]);
  if (waterAvailable) drivers.push([HAZARD_WEIGHTS.water, waterIdx]);
  const wsum = drivers.reduce((a, [w]) => a + w, 0);
  const hazard = wsum ? drivers.reduce((a, [w, v]) => a + w * v, 0) / wsum : 0;
  const terrainFactor = terrain === null ? TERRAIN_FACTOR.unknown : TERRAIN_FACTOR.base + TERRAIN_FACTOR.span * terrain;
  const ground = Math.max(groundIdx * (contested ? 0.5 : 1), roadStrong ? 1 : 0);
  const risk = Math.round(100 * clamp01((1 - GROUND_RISK_WEIGHT) * hazard * terrainFactor + GROUND_RISK_WEIGHT * ground));

  return {
    settlement_id: s.id,
    level,
    initial_level: initial,
    candidate_level: candidate,
    risk,
    confidence,
    evidence,
    data_gaps: gaps,
    verification_requested: verificationRequested,
    false_alert_notes: notes,
    downgrade_pending_since: pendingSince,
    would_increase: wouldIncrease(level, { rainDriver, waterExpected, supportCount, roadStrong, strongClasses }),
    would_decrease: wouldDecrease(level),
    version: previous?.version ?? 0,
    reason_for_change: null,
    as_of: new Date(now).toISOString(),
  };
}

/**
 * River-level severity index (0..1). Prototype banding around the gauge's reference levels:
 *   below 85% of warning level → 0;  85% of warning → warning = WATCH band (⅓..⅔);
 *   warning → danger = WARNING band (⅔..1);  at/above danger = 1.
 */
export function riverIndex(level: number, warningLevel: number, dangerLevel: number): number {
  const approach = 0.85 * warningLevel;
  if (level < approach) return 0;
  if (level < warningLevel) return 1 / 3 + ((level - approach) / (warningLevel - approach)) / 3;
  if (level < dangerLevel) return 2 / 3 + ((level - warningLevel) / (dangerLevel - warningLevel)) / 3;
  return 1;
}

function latestReportTime(reports: GroundReport[], stance: 'support' | 'conflict'): string | null {
  const times = reports.filter((r) => reportStance(r) === stance).map((r) => r.received_at).sort();
  return times.length ? times[times.length - 1] : null;
}

function describeVerification(reports: GroundReport[]): string {
  const count = (v: string) => reports.filter((r) => r.verification === v).length;
  return ['verified', 'corroborated', 'unverified', 'disputed']
    .map((v) => (count(v) ? `${count(v)} ${v}` : null)).filter(Boolean).join(', ') || 'none';
}

function modeOf(reports: GroundReport[]): EvidenceItem['mode'] {
  const modes = new Set(reports.map((r) => r.mode));
  if (modes.has('live')) return 'live';
  if (modes.has('replay')) return 'replay';
  return 'synthetic_scenario';
}

function wouldIncrease(level: WarningLevel, f: { rainDriver: number; waterExpected: boolean; supportCount: number; roadStrong: boolean; strongClasses: string[] }): string[] {
  if (level === 'SEVERE') return [];
  const out: string[] = [];
  if (f.rainDriver < 1) out.push('Further heavy rainfall over the next hours');
  if (f.waterExpected) out.push('River level rising towards the warning / danger level');
  if (f.supportCount < 2) out.push('Independent ground reports confirming flooding');
  else out.push('Coordinator verification of the existing reports');
  if (!f.roadStrong) out.push('A confirmed road or bridge closure near the settlement');
  return out;
}

function wouldDecrease(level: WarningLevel): string[] {
  if (level === 'NONE') return [];
  return [
    'Sustained decrease in rainfall (it must hold for 3 hours before a downgrade)',
    'River level falling below the warning level',
    'Verified reports that roads are open / no flooding',
    'Closed roads reopening',
  ];
}
