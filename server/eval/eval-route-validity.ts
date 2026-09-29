/**
 * Route validity under simulated disruption, on the REAL Kolhapur OSM road graph.
 *
 * For deterministic seeds and three disruption modes (random closures, flood-prone closures, replay
 * scenario closures), for many response-base → settlement pairs:
 *   1. compute the undisrupted baseline route
 *   2. close roads
 *   3. compute the route again with the production router
 *   4. independently VERIFY the route: every segment exists, no closed segment is used, the geometry is
 *      continuous, and it ends at the settlement's road node
 *   5. when the router says "no route" (CUT OFF), confirm with an independent reachability search
 * and measure detour cost. A route that fails any check counts as INVALID (none should).
 *
 *   npm run eval:route-validity   →  server/results/route-validity/results.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoadSegment, RoadState, RouteResult } from '../../shared/types.js';
import { loadGeography } from '../src/data/geography.js';
import { loadEvent, listEvents } from '../src/replay/event.js';
import { RoadGraph } from '../src/routing/graph.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'server', 'results', 'route-validity');
const SEEDS = 50;
const PAIRS_PER_SEED = 20;

/** mulberry32 — small deterministic PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(r: () => number, arr: T[]) => arr[Math.floor(r() * arr.length)];

const closed = (ids: Iterable<string>) => new Map<string, RoadState>([...ids].map((id) => [id, { segment_id: id, status: 'BLOCKED', reason: 'eval', source: 'eval', mode: 'synthetic_scenario', since: null }]));

function verify(route: RouteResult, source: string, target: string, statuses: Map<string, RoadState>, segs: Map<string, RoadSegment>, graph: RoadGraph): string | null {
  if (!route.segment_ids.length) return null; // same node
  const start = graph.nodes.get(source)!;
  if (Math.abs(route.coords[0][0] - start.lat) > 1e-7 || Math.abs(route.coords[0][1] - start.lng) > 1e-7) return 'does not start at the base road node';
  let at: [number, number] | null = null;
  for (const id of route.segment_ids) {
    const s = segs.get(id);
    if (!s) return `unknown segment ${id}`;
    if (statuses.get(id)?.status === 'BLOCKED') return `uses closed segment ${id}`;
    const a = s.coords[0], b = s.coords[s.coords.length - 1];
    if (at) {
      const joinsA: boolean = Math.abs(at[0] - a[0]) < 1e-7 && Math.abs(at[1] - a[1]) < 1e-7;
      const joinsB: boolean = Math.abs(at[0] - b[0]) < 1e-7 && Math.abs(at[1] - b[1]) < 1e-7;
      if (!joinsA && !joinsB) return `geometry gap before ${id}`;
      at = joinsA ? b : a;
    } else {
      at = b; // first segment: orientation fixed by the next join
      const next = segs.get(route.segment_ids[1] ?? '');
      if (next) {
        const nb = [next.coords[0], next.coords[next.coords.length - 1]];
        const touches = (p: [number, number]) => nb.some((q) => Math.abs(q[0] - p[0]) < 1e-7 && Math.abs(q[1] - p[1]) < 1e-7);
        at = touches(b) ? b : a;
      }
    }
  }
  const end = graph.nodes.get(target)!;
  const last = route.coords[route.coords.length - 1];
  if (Math.abs(last[0] - end.lat) > 1e-7 || Math.abs(last[1] - end.lng) > 1e-7) return 'does not end at the settlement road node';
  return null;
}

function main() {
  const geo = loadGeography();
  const graph = new RoadGraph(geo.segments);
  const segs = graph.segments;
  const hosting = new Set(geo.units.map((u) => u.base_id));
  const bases = geo.bases.filter((b) => hosting.has(b.id) && b.road_node && graph.hasNode(b.road_node));
  const targets = geo.settlements.filter((s) => s.road_node && graph.hasNode(s.road_node));
  const floodProne = geo.segments.filter((s) => s.flood_prone).map((s) => s.id);
  const allIds = geo.segments.map((s) => s.id);

  // Replay-scenario closures (all closure events in the scenario, applied together).
  const ev = listEvents().find((e) => e.has_scenario);
  const replayClosures = ev ? loadEvent(ev.id, geo.settlements, geo.segments).roadEvents.filter((e) => e.action === 'close').map((e) => e.segment_id) : [];

  const modes: { name: string; closures: (r: () => number) => string[] }[] = [
    { name: 'random disruption (3% of segments)', closures: (r) => allIds.filter(() => r() < 0.03) },
    { name: 'flood-prone roads (50% of flood-prone segments)', closures: (r) => floodProne.filter(() => r() < 0.5) },
    { name: 'replay scenario closures', closures: () => replayClosures },
  ];

  const summary: Record<string, unknown>[] = [];
  const failures: { mode: string; seed: number; reason: string }[] = [];
  for (const mode of modes) {
    let tested = 0, valid = 0, invalid = 0, rerouted = 0, invalidatedBaseline = 0, cutOffCorrect = 0, cutOffWrong = 0, unchanged = 0;
    const detours: number[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed * 7919 + mode.name.length);
      const statuses = closed(mode.closures(r));
      for (let k = 0; k < PAIRS_PER_SEED; k++) {
        const base = pick(r, bases);
        const target = pick(r, targets);
        const baseline = graph.route(base.road_node!, target.road_node!, new Map(), { penalise: false });
        if (baseline.status !== 'ok') continue; // not connected even without disruption
        tested++;
        const baselineHit = baseline.segment_ids.some((id) => statuses.has(id));
        if (baselineHit) invalidatedBaseline++;
        const route = graph.route(base.road_node!, target.road_node!, statuses, { penalise: false });
        const reachable = graph.reachable(base.road_node!, statuses).has(target.road_node!);
        if (route.status === 'no_route') {
          if (!reachable) cutOffCorrect++; else { cutOffWrong++; failures.push({ mode: mode.name, seed, reason: 'reported CUT OFF but a route exists' }); }
          continue;
        }
        const problem = verify(route, base.road_node!, target.road_node!, statuses, segs, graph);
        if (problem) { invalid++; failures.push({ mode: mode.name, seed, reason: problem }); continue; }
        if (!reachable) { invalid++; failures.push({ mode: mode.name, seed, reason: 'route returned but target unreachable' }); continue; }
        valid++;
        if (baselineHit) { rerouted++; detours.push((route.duration_s - baseline.duration_s) / Math.max(1, baseline.duration_s) * 100); }
        else unchanged++;
      }
    }
    const decided = valid + invalid + cutOffCorrect + cutOffWrong;
    summary.push({
      mode: mode.name, seeds: SEEDS, routes_tested: tested, valid_routes: valid, invalid_routes: invalid,
      baseline_routes_invalidated_by_closures: invalidatedBaseline, successful_reroutes: rerouted, unaffected: unchanged,
      unreachable_correctly_detected: cutOffCorrect, unreachable_wrongly_reported: cutOffWrong,
      route_validity_pct: decided ? Math.round(((valid + cutOffCorrect) / decided) * 1000) / 10 : null,
      avg_detour_pct: detours.length ? Math.round((detours.reduce((a, b) => a + b, 0) / detours.length) * 10) / 10 : null,
      max_detour_pct: detours.length ? Math.round(Math.max(...detours) * 10) / 10 : null,
    });
  }

  console.log(`\nRoute validity on the Kolhapur OSM road graph (${geo.segments.length} segments, ${graph.nodeCount} nodes, ${bases.length} response bases, ${targets.length} settlements)`);
  console.table(summary.map((s) => ({
    mode: s.mode, tested: s.routes_tested, valid: s.valid_routes, invalid: s.invalid_routes, reroutes: s.successful_reroutes,
    'cut off (correct)': s.unreachable_correctly_detected, 'cut off (wrong)': s.unreachable_wrongly_reported,
    'validity %': s.route_validity_pct, 'avg detour %': s.avg_detour_pct, 'max detour %': s.max_detour_pct,
  })));
  if (failures.length) console.log('Failures:', failures.slice(0, 20));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    network: { source: 'OpenStreetMap (ODbL), Kolhapur District, largest connected component', segments: geo.segments.length, nodes: graph.nodeCount },
    method: 'Deterministic seeds (mulberry32). Each route is independently verified: existing segments only, no closed segment, continuous geometry, ends at the settlement road node. Every CUT OFF verdict is checked with an independent reachability search.',
    limitations: [
      'Validates the local graph router on the mapped network; OSM may miss village roads or contain outdated segments.',
      'Travel times use prototype free-flow speeds per road class, not observed traffic or flood-reduced speeds.',
      'Closures are simulated; they do not reproduce the real 2019/2021 closure pattern.',
    ],
    results: summary, failures,
  }, null, 2));
  console.log('Wrote server/results/route-validity/results.json');
  if (failures.length) process.exitCode = 1;
}

main();
