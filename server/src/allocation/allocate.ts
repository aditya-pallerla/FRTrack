/**
 * Response recommendations: which unit should go to which settlement, by which valid road route.
 *
 *  1. Demand   — each prioritised settlement needs a set of unit "slots" (policy below).
 *  2. Supply   — available units, plus approved units not yet moving (a move costs a penalty).
 *  3. Utility  — U = (priority/100)² × importance × time value(ETA) − move cost.
 *  4. Solve    — exact Hungarian assignment across ALL settlements at once.
 *  5. Validate — every approved assignment's route is re-checked against current closures; a blocked
 *                route yields a REROUTE proposal (with ETA change) or a REPLACEMENT when no route exists.
 *
 * Output is proposals only. Nothing is dispatched until a coordinator approves.
 * Policy values are prototype assumptions (documented, not validated standards).
 */
import type {
  Assignment, GroundReport, PriorityBand, Recommendation, RoadState, RouteResult, Settlement,
  SettlementAccess, SettlementPriority, SettlementWarning, Unit,
} from '../../../shared/types.js';
import { haversineM } from '../engine/geo.js';
import type { PathTree, RoadGraph } from '../routing/graph.js';
import { maxWeightAssignment } from './hungarian.js';

export const ALLOC = {
  target_min: { CRITICAL: 20, HIGH: 30, MEDIUM: 45, LOW: 60 } as Record<PriorityBand, number>,
  max_eta_min: 120,
  move_cost: 0.15,
  essential: 1,
  support: 0.6,
};

interface Slot { settlement_id: string; type: Unit['type']; importance: number; purpose: string; key: string }

export interface AllocationInput {
  units: Unit[];
  settlements: Map<string, Settlement>;
  priorities: SettlementPriority[];
  warnings: Map<string, SettlementWarning>;
  access: Map<string, SettlementAccess>;
  reportsBySettlement: Map<string, GroundReport[]>;
  assignments: Assignment[];
  /** unit|settlement pairs a coordinator rejected; not proposed again. */
  rejected: Set<string>;
  graph: RoadGraph;
  statuses: Map<string, RoadState>;
}

export interface AllocationResult {
  recommendations: Recommendation[];
  unmet: { settlement_id: string; need: string; reason: string }[];
}

/** Demand policy per settlement (prototype). */
export function buildSlots(p: SettlementPriority, w: SettlementWarning, a: SettlementAccess | undefined, reports: GroundReport[]): Slot[] {
  const live = reports.filter((r) => r.verification !== 'disputed');
  const trapped = live.some((r) => r.evidence.people_trapped !== 0 || r.evidence.kinds.includes('people_trapped') || r.evidence.kinds.includes('rescue_needed'));
  const injured = live.some((r) => r.evidence.injured !== 0);
  const cutOff = a?.status === 'CUT_OFF';
  const slots: Omit<Slot, 'key'>[] = [];
  const add = (type: Unit['type'], importance: number, purpose: string) => slots.push({ settlement_id: p.settlement_id, type, importance, purpose });
  // WATCH means "monitor": units are only proposed once a settlement is at WARNING or above.
  if (w.level === 'NONE' || w.level === 'WATCH' || p.band === 'LOW') return [];
  if (p.band === 'CRITICAL' || p.band === 'HIGH') {
    if (cutOff || trapped || w.level === 'SEVERE') add('rescue_boat', ALLOC.essential, cutOff ? 'no road access — boat rescue' : 'water rescue');
    if (!cutOff) add('rescue_team', ALLOC.essential, trapped ? 'rescue of trapped people' : 'flood response');
    if (!cutOff && (injured || trapped)) add('ambulance', ALLOC.essential, injured ? 'casualty transport' : 'standby for rescued people');
    if (!cutOff) add('police', ALLOC.support, 'evacuation and traffic control');
  } else if (!cutOff) {
    add('police', ALLOC.support, 'evacuation advisory');
  }
  const count = new Map<string, number>();
  return slots.map((s) => {
    const n = (count.get(s.type) ?? 0) + 1;
    count.set(s.type, n);
    return { ...s, key: `${s.settlement_id}:${s.type}#${n}` };
  });
}

function timeValue(etaMin: number, band: PriorityBand) {
  const t = ALLOC.target_min[band];
  return etaMin <= t ? 1 : Math.exp(-(etaMin - t) / t);
}

/**
 * Road route for a unit to a settlement. Boats drive to the reachable road point nearest the settlement
 * ("staging point"); the final water leg is shown separately and is NOT a road route.
 */
function unitRoute(unit: Unit, s: Settlement, tree: PathTree, graph: RoadGraph, statuses: Map<string, RoadState>, cutOff: boolean):
  { route: RouteResult; staging_note: string | null } | null {
  if (!unit.road_node || !s.road_node) return null;
  if (!cutOff) {
    const r = graph.pathTo(tree, s.road_node, statuses);
    return r.status === 'ok' ? { route: r, staging_note: null } : null;
  }
  if (unit.type !== 'rescue_boat') return null;
  let best: string | null = null;
  let bestD = Infinity;
  for (const node of tree.dist.keys()) {
    const p = graph.nodes.get(node);
    if (!p) continue;
    const d = haversineM(p, s);
    if (d < bestD) { bestD = d; best = node; }
  }
  if (!best) return null;
  const r = graph.pathTo(tree, best, statuses);
  if (r.status !== 'ok') return null;
  return { route: r, staging_note: `Road route to staging point; final boat leg ≈ ${(bestD / 1000).toFixed(1)} km across flood water (not road-routed)` };
}

export function allocate(inp: AllocationInput): AllocationResult {
  const recs: Recommendation[] = [];
  const unmet: AllocationResult['unmet'] = [];
  const prio = new Map(inp.priorities.map((p) => [p.settlement_id, p]));
  const treeFor = (node: string) => inp.graph.cachedTree(node, inp.statuses);

  // ── Validate existing approved assignments against today's roads ──
  const active = inp.assignments.filter((a) => a.status === 'assigned' || a.status === 'en_route');
  const unitById = new Map(inp.units.map((u) => [u.id, u]));
  const replacementNeeded = new Set<string>();
  for (const a of active) {
    const blocked = a.route.segment_ids.filter((id) => inp.statuses.get(id)?.status === 'BLOCKED');
    if (!blocked.length) continue;
    const u = unitById.get(a.unit_id);
    const s = inp.settlements.get(a.settlement_id);
    if (!u || !s || !u.road_node) continue;
    const cutOff = inp.access.get(s.id)?.status === 'CUT_OFF';
    const r = unitRoute(u, s, treeFor(u.road_node), inp.graph, inp.statuses, cutOff);
    if (r) {
      const eta = Math.round(r.route.duration_s / 60);
      recs.push({
        id: `reroute:${a.id}:${r.route.segment_ids.length}:${eta}`, unit_id: u.id, settlement_id: s.id, kind: 'reroute', eta_min: eta,
        route: r.route, staging_note: r.staging_note, utility: 0, status: 'proposed',
        reasons: [`Approved route now blocked (${blocked.length} segment${blocked.length > 1 ? 's' : ''})`, `Alternative route found: ETA ${eta} min (${eta - a.eta_min >= 0 ? '+' : ''}${eta - a.eta_min} min)`],
      });
    } else {
      replacementNeeded.add(a.id);
      unmet.push({ settlement_id: s.id, need: u.type.replace('_', ' '), reason: `${u.name}: no valid road route any more — replacement sought` });
    }
  }

  // ── Demand ──
  const slots: Slot[] = [];
  for (const p of inp.priorities) {
    const w = inp.warnings.get(p.settlement_id);
    if (!w) continue;
    slots.push(...buildSlots(p, w, inp.access.get(p.settlement_id), inp.reportsBySettlement.get(p.settlement_id) ?? []));
  }
  // Slots already covered by a valid active assignment are pinned.
  const covered = new Set<string>();
  const pinnedUnits = new Set<string>();
  for (const a of active) {
    if (replacementNeeded.has(a.id)) continue;
    const u = unitById.get(a.unit_id);
    const slot = slots.find((s) => s.settlement_id === a.settlement_id && s.type === u?.type && !covered.has(s.key));
    if (slot) covered.add(slot.key);
    // Units that are moving or on scene never move again automatically.
    if (a.status === 'en_route' || !slot) pinnedUnits.add(a.unit_id);
  }
  for (const a of inp.assignments) if (a.status === 'on_scene') pinnedUnits.add(a.unit_id);
  const open = slots.filter((s) => !covered.has(s.key));

  // ── Supply ──
  const assignedTo = new Map(active.map((a) => [a.unit_id, a]));
  const candidates = inp.units.filter((u) => u.road_node && !pinnedUnits.has(u.id)
    && (u.status === 'available' || (u.status === 'assigned' && !replacementNeeded.has(assignedTo.get(u.id)?.id ?? ''))));

  // ── Utility matrix ──
  type Cell = { u: number; route: RouteResult; staging: string | null; eta: number; move: boolean } | null;
  const cells: Cell[][] = candidates.map((u) => open.map((slot) => {
    if (u.type !== slot.type || inp.rejected.has(`${u.id}|${slot.settlement_id}`)) return null;
    const s = inp.settlements.get(slot.settlement_id)!;
    const p = prio.get(slot.settlement_id)!;
    const cutOff = inp.access.get(s.id)?.status === 'CUT_OFF';
    const r = unitRoute(u, s, treeFor(u.road_node!), inp.graph, inp.statuses, cutOff);
    if (!r) return null;
    const eta = Math.round(r.route.duration_s / 60);
    if (eta > ALLOC.max_eta_min) return null;
    const move = u.status === 'assigned' && assignedTo.get(u.id)?.settlement_id !== slot.settlement_id;
    const utility = (p.score / 100) ** 2 * slot.importance * timeValue(eta, p.band) - (move ? ALLOC.move_cost : 0);
    return { u: utility, route: r.route, staging: r.staging_note, eta, move };
  }));
  const result = maxWeightAssignment(cells.map((row) => row.map((c) => (c ? c.u : null))), open.length);

  // ── Proposals ──
  const filled = new Set<number>();
  for (const [ui, si] of result.pairs) {
    const c = cells[ui][si]!;
    const u = candidates[ui];
    const slot = open[si];
    const p = prio.get(slot.settlement_id)!;
    const w = inp.warnings.get(slot.settlement_id)!;
    const acc = inp.access.get(slot.settlement_id);
    // A unit already assigned to this settlement just stays.
    if (u.status === 'assigned' && !c.move) continue;
    filled.add(si);
    const reasons = [
      `${p.band} priority (score ${p.score}), flood ${w.level}`,
      `Need: ${slot.type.replace('_', ' ')} — ${slot.purpose}`,
      `ETA ${c.eta} min by road${acc?.status === 'DEGRADED' ? ' (detour — usual route disrupted)' : ''}`,
      ...(c.move ? [`Reassignment: currently assigned to ${inp.settlements.get(assignedTo.get(u.id)!.settlement_id)?.name}`] : []),
    ];
    const replaced = active.find((a) => a.settlement_id === slot.settlement_id && replacementNeeded.has(a.id) && unitById.get(a.unit_id)?.type === slot.type);
    recs.push({
      id: `${c.move ? 'reassign' : replaced ? 'replacement' : 'new'}:${u.id}:${slot.key}`,
      unit_id: u.id, settlement_id: slot.settlement_id, kind: c.move ? 'reassign' : replaced ? 'replacement' : 'new',
      eta_min: c.eta, route: c.route, staging_note: c.staging, reasons, utility: Math.round(c.u * 1000) / 1000, status: 'proposed',
    });
  }
  open.forEach((slot, i) => {
    if (filled.has(i)) return;
    const any = cells.some((row) => row[i] !== null);
    unmet.push({
      settlement_id: slot.settlement_id, need: slot.type.replace('_', ' '),
      reason: any ? 'suitable units are committed to higher-priority needs' : `no available ${slot.type.replace('_', ' ')} can reach it by road within ${ALLOC.max_eta_min} min`,
    });
  });
  return { recommendations: recs, unmet };
}
