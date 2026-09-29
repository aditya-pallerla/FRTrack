/** Hungarian solver and response recommendations (proposals only — never automatic dispatch). */
import type { Assignment, RoadState, SettlementPriority, Unit } from '../../shared/types.js';
import { allocate } from '../src/allocation/allocate.js';
import { maxWeightAssignment } from '../src/allocation/hungarian.js';
import { assessSettlement } from '../src/engine/assess.js';
import { aggregateCell } from '../src/engine/rainfall.js';
import { RoadGraph } from '../src/routing/graph.js';
import { AccessCalculator } from '../src/engine/access.js';
import { BASE, T0, grid, hourly, settlement } from './fixtures.js';
import { assert, eq, runStandalone, test } from './harness.js';

const unit = (id: string, type: Unit['type']): Unit => ({
  id, name: id, type, base_id: 'B1', road_node: 'n00', status: 'available', capabilities: [], synthetic: true,
});
const block = (...ids: string[]) => new Map<string, RoadState>(ids.map((id) => [id, { segment_id: id, status: 'BLOCKED', reason: 't', source: 't', mode: 'synthetic_scenario', since: null }]));

function scenario(roadNode: string, statuses: Map<string, RoadState>, units: Unit[], assignments: Assignment[] = []) {
  const [r, c] = [Number(roadNode[1]), Number(roadNode[2])];
  const s = settlement({ road_node: roadNode, lat: 16.7 + r * 0.01, lng: 74.25 + c * 0.01 });
  const graph = new RoadGraph(grid());
  const access = new AccessCalculator(graph, [BASE]).compute([s], statuses);
  const w = assessSettlement({
    settlement: s, now: T0, rain: aggregateCell('C1', hourly([0, 0, 0, 0, 0, 0, 22, 22, 22, 22, 22, 22]), T0),
    water: null, reports: [], closures: [], previous: null,
  });
  const p: SettlementPriority = {
    settlement_id: s.id, score: 90, band: 'CRITICAL', rank: 1, components: { level: 1, exposure: 1, vulnerability: 1, rescue: 1, access: 1, trend: 1 },
    unknowns: [], previous_rank: null, previous_score: null, changes: [],
  };
  return allocate({
    units, settlements: new Map([[s.id, s]]), priorities: [p], warnings: new Map([[s.id, { ...w, level: 'SEVERE' }]]),
    access, reportsBySettlement: new Map(), assignments, rejected: new Set(), graph, statuses,
  });
}

test('Hungarian finds the global optimum, not the greedy choice', () => {
  const r = maxWeightAssignment([[3, 2.9], [2.5, null]]);
  // Greedy would take (0,0)=3 and leave row 1 unmatched (total 3). Optimum is 2.9 + 2.5 = 5.4.
  eq(Math.round(r.total * 10) / 10, 5.4, 'total');
});

test('infeasible pairs are never selected', () => {
  eq(maxWeightAssignment([[null, null]]).pairs.length, 0, 'no pairs');
});

test('recommendations are proposals only — nothing is dispatched automatically', () => {
  const res = scenario('n11', new Map(), [unit('T1', 'rescue_team'), unit('B1', 'rescue_boat'), unit('P1', 'police')]);
  assert(res.recommendations.length > 0, 'something recommended');
  assert(res.recommendations.every((r) => r.status === 'proposed'), 'all proposed, none dispatched');
  assert(res.recommendations.every((r) => r.route.status === 'ok' && r.route.segment_ids.length > 0), 'every proposal has a real road route');
});

test('a CUT OFF settlement gets a boat to a staging point, and no road units', () => {
  const res = scenario('n33', block('v23', 'h32'), [unit('T1', 'rescue_team'), unit('BOAT', 'rescue_boat')]);
  eq(res.recommendations.length, 1, 'one proposal');
  eq(res.recommendations[0].unit_id, 'BOAT', 'boat');
  assert(!!res.recommendations[0].staging_note?.includes('not road-routed'), 'final water leg labelled as not road-routed');
});

test('an approved route that becomes blocked yields a REROUTE proposal that avoids the closure', () => {
  const graph = new RoadGraph(grid());
  const original = graph.route('n00', 'n11');
  const a: Assignment = {
    id: 'A1', unit_id: 'T1', settlement_id: 'S1', status: 'en_route', route: original, eta_min: 3, staging_note: null,
    approved_by: 'test', approved_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString(),
  };
  const res = scenario('n11', block(original.segment_ids[0]), [{ ...unit('T1', 'rescue_team'), status: 'en_route' }], [a]);
  const rr = res.recommendations.find((r) => r.kind === 'reroute');
  assert(!!rr, 'reroute proposed');
  assert(!rr!.route.segment_ids.includes(original.segment_ids[0]), 'new route avoids the blocked segment');
  eq(rr!.status, 'proposed', 'reroute still needs approval');
});

await runStandalone('Allocation');
