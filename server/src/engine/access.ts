/**
 * Settlement access from the nearest response base, comparing the current road network with the
 * undisrupted baseline:
 *   REACHABLE — a route exists and is not materially slower than normal
 *   DEGRADED  — a route exists but is ≥15% slower, detours round a closure, or uses an AT_RISK road
 *   CUT_OFF   — no route from any base in the mapped road network
 *   UNKNOWN   — the settlement has no road access in the data
 */
import type { ResponseBase, RoadState, Settlement, SettlementAccess } from '../../../shared/types.js';
import type { PathTree, RoadGraph } from '../routing/graph.js';
import { ACCESS } from './config.js';

export class AccessCalculator {
  private baseline: Map<string, PathTree> | null = null;

  constructor(private readonly graph: RoadGraph, private readonly bases: ResponseBase[]) {}

  private routable() { return this.bases.filter((b) => b.road_node && this.graph.hasNode(b.road_node)); }

  private baselineTrees() {
    if (!this.baseline) {
      this.baseline = new Map(this.routable().map((b) => [b.id, this.graph.tree(b.road_node!, new Map(), { penalise: false })]));
    }
    return this.baseline;
  }

  compute(settlements: Settlement[], statuses: Map<string, RoadState>): Map<string, SettlementAccess> {
    const bases = this.routable();
    const base = this.baselineTrees();
    const current = new Map(bases.map((b) => [b.id, this.graph.cachedTree(b.road_node!, statuses)]));
    const out = new Map<string, SettlementAccess>();
    for (const s of settlements) {
      if (!s.road_node || !this.graph.hasNode(s.road_node)) {
        out.set(s.id, { settlement_id: s.id, status: 'UNKNOWN', base_id: null, route: null, baseline_duration_s: null, eta_delta_min: null, blocked_on_baseline: [], note: 'No road access in the mapped network' });
        continue;
      }
      // Baseline: fastest base on the undisrupted network.
      let bBase: string | null = null;
      let bDur = Infinity;
      for (const b of bases) {
        const d = base.get(b.id)!.dist.get(s.road_node);
        if (d !== undefined && d < bDur) { bDur = d; bBase = b.id; }
      }
      // Current: fastest base on today's network (penalised cost chooses; true duration reported).
      let cBase: string | null = null;
      let cCost = Infinity;
      for (const b of bases) {
        const d = current.get(b.id)!.dist.get(s.road_node);
        if (d !== undefined && d < cCost) { cCost = d; cBase = b.id; }
      }
      const baselineRoute = bBase ? this.graph.pathTo(base.get(bBase)!, s.road_node) : null;
      const blockedOnBaseline = baselineRoute?.segment_ids.filter((id) => statuses.get(id)?.status === 'BLOCKED') ?? [];
      if (!cBase) {
        out.set(s.id, {
          settlement_id: s.id, status: 'CUT_OFF', base_id: null, route: null,
          baseline_duration_s: Number.isFinite(bDur) ? Math.round(bDur) : null, eta_delta_min: null, blocked_on_baseline: blockedOnBaseline,
          note: 'No road route from any response base — requires boat team or a manual decision',
        });
        continue;
      }
      const route = this.graph.pathTo(current.get(cBase)!, s.road_node, statuses);
      const slower = Number.isFinite(bDur) && route.duration_s > bDur * ACCESS.degraded_ratio;
      const degraded = slower || blockedOnBaseline.length > 0 || route.uses_at_risk.length > 0;
      const reasons = [
        blockedOnBaseline.length ? `usual route blocked (${blockedOnBaseline.length} segment${blockedOnBaseline.length > 1 ? 's' : ''})` : null,
        slower ? `detour ${Math.round((route.duration_s - bDur) / 60)} min slower than normal` : null,
        route.uses_at_risk.length ? `route uses ${route.uses_at_risk.length} at-risk road segment${route.uses_at_risk.length > 1 ? 's' : ''}` : null,
      ].filter(Boolean);
      out.set(s.id, {
        settlement_id: s.id, status: degraded ? 'DEGRADED' : 'REACHABLE', base_id: cBase, route,
        baseline_duration_s: Number.isFinite(bDur) ? Math.round(bDur) : null,
        eta_delta_min: Number.isFinite(bDur) ? Math.round((route.duration_s - bDur) / 60) : null,
        blocked_on_baseline: blockedOnBaseline,
        note: reasons.length ? reasons.join('; ') : null,
      });
    }
    return out;
  }
}
