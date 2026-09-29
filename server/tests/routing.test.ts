/** Road router, road status rules and settlement access (on a synthetic test grid). */
import type { RoadEvent, RoadState } from '../../shared/types.js';
import { AccessCalculator } from '../src/engine/access.js';
import { applyVerification } from '../src/engine/reports.js';
import { computeRoadStates } from '../src/engine/roads.js';
import { RoadGraph } from '../src/routing/graph.js';
import { BASE, T0, evidence, grid, report, settlement } from './fixtures.js';
import { assert, eq, runStandalone, test } from './harness.js';

const blocked = (...ids: string[]) => new Map<string, RoadState>(ids.map((id) => [id, { segment_id: id, status: 'BLOCKED', reason: 'test', source: 'test', mode: 'synthetic_scenario', since: null }]));
const atRisk = (m: Map<string, RoadState>, id: string) => m.set(id, { segment_id: id, status: 'AT_RISK', reason: 'test', source: 'test', mode: 'static', since: null });

test('fastest route follows real road segments end to end', () => {
  const g = new RoadGraph(grid());
  const r = g.route('n00', 'n33');
  eq(r.status, 'ok', 'status');
  eq(r.segment_ids.length, 6, 'six grid segments');
  eq(r.duration_s, 594, 'duration = 6 × 1100 m at 40 km/h');
  const near = (p: [number, number], lat: number, lng: number) => Math.abs(p[0] - lat) < 1e-9 && Math.abs(p[1] - lng) < 1e-9;
  assert(near(r.coords[0], 16.7, 74.25), 'starts at origin');
  assert(near(r.coords[r.coords.length - 1], 16.73, 74.28), 'ends at destination');
  // Continuity: every consecutive pair of points is at most one grid step apart (no jumps).
  for (let i = 1; i < r.coords.length; i++) {
    const step = Math.abs(r.coords[i][0] - r.coords[i - 1][0]) + Math.abs(r.coords[i][1] - r.coords[i - 1][1]);
    assert(step <= 0.0100001, `gap in route geometry at point ${i}`);
  }
});

test('a blocked segment is never used; an alternative is found', () => {
  const g = new RoadGraph(grid());
  const base = g.route('n00', 'n01');
  eq(base.segment_ids.join(), 'h00', 'direct');
  const alt = g.route('n00', 'n01', blocked('h00'));
  eq(alt.status, 'ok', 'alternative exists');
  assert(!alt.segment_ids.includes('h00'), 'avoids blocked segment');
  eq(alt.segment_ids.length, 3, 'detour length');
});

test('no route when every connection is blocked, confirmed by reachability', () => {
  const g = new RoadGraph(grid());
  const st = blocked('h00', 'v00');
  eq(g.route('n00', 'n33', st).status, 'no_route', 'no route');
  eq(g.reachable('n00', st).size, 1, 'origin is isolated');
});

test('AT_RISK roads are avoided when a safe alternative exists', () => {
  const g = new RoadGraph(grid());
  const st = new Map<string, RoadState>();
  atRisk(st, 'h00');
  const r = g.route('n00', 'n11', st);
  assert(!r.segment_ids.includes('h00'), 'prefers the equally long safe path');
  eq(r.uses_at_risk.length, 0, 'no at-risk segments');
});

test('access: REACHABLE → DEGRADED → CUT_OFF', () => {
  const g = new RoadGraph(grid());
  const calc = new AccessCalculator(g, [BASE]);
  const s = settlement({ road_node: 'n01' });
  eq(calc.compute([s], new Map()).get('S1')!.status, 'REACHABLE', 'normal');
  const d = calc.compute([s], blocked('h00')).get('S1')!;
  eq(d.status, 'DEGRADED', 'usual route blocked');
  eq(d.eta_delta_min, 3, '+3 min detour (2 extra segments)');
  eq(d.blocked_on_baseline.join(), 'h00', 'which segment broke the usual route');
  eq(calc.compute([s], blocked('h00', 'v00')).get('S1')!.status, 'CUT_OFF', 'isolated');
});

test('settlement without road access in the data is UNKNOWN, not guessed', () => {
  const calc = new AccessCalculator(new RoadGraph(grid()), [BASE]);
  eq(calc.compute([settlement({ road_node: null })], new Map()).get('S1')!.status, 'UNKNOWN', 'status');
});

test('road status: an unverified road report only marks AT_RISK; corroborated reports BLOCK', () => {
  const segs = grid();
  const onH00 = { lat: 16.7, lng: 74.255 };
  const one = applyVerification([report({ ...onH00, evidence: evidence({ kinds: ['road_flooded'], road_blocked: true }) })], new Map(), T0);
  let st = computeRoadStates({ segments: segs, reports: one, events: [], settlements: [], warnings: new Map(), now: T0 });
  eq(st.get('h00')?.status, 'AT_RISK', 'single unverified report');
  const two = applyVerification([
    report({ ...onH00, evidence: evidence({ kinds: ['road_flooded'], road_blocked: true }) }),
    report({ lat: 16.7002, lng: 74.256, evidence: evidence({ kinds: ['road_flooded'], road_blocked: true }) }),
  ], new Map(), T0);
  st = computeRoadStates({ segments: segs, reports: two, events: [], settlements: [], warnings: new Map(), now: T0 });
  eq(st.get('h00')?.status, 'BLOCKED', 'two independent reporters');
});

test('road status: closure and reopen events; future events are ignored', () => {
  const ev = (action: 'close' | 'reopen', minutes: number): RoadEvent => ({
    id: `${action}${minutes}`, segment_id: 'h00', action, at: new Date(T0 + minutes * 60_000).toISOString(),
    reason: 'test', origin: 'coordinator', source: 'test', mode: 'synthetic_scenario',
  });
  const base = { segments: grid(), reports: [], settlements: [], warnings: new Map() };
  eq(computeRoadStates({ ...base, events: [ev('close', -10)], now: T0 }).get('h00')?.status, 'BLOCKED', 'closed');
  eq(computeRoadStates({ ...base, events: [ev('close', -10), ev('reopen', -5)], now: T0 }).has('h00'), false, 'reopened');
  eq(computeRoadStates({ ...base, events: [ev('close', 10)], now: T0 }).has('h00'), false, 'future closure not applied');
});

await runStandalone('Routing and road status');
