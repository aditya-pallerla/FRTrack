/**
 * Road status: OPEN / AT_RISK / BLOCKED. A road is never closed just because it is near a flood.
 *
 *  BLOCKED  ← a coordinator / documented / scenario closure event, OR a corroborated or verified
 *             report of a flooded road / submerged bridge within 150 m of the segment.
 *  AT_RISK  ← an UNVERIFIED blocked-road report (needs verification), OR a flood-prone segment
 *             (bridge, ford, low-lying near a river) within 3 km of a settlement at WARNING or above.
 *  OPEN     ← everything else. A later verified "road open" report or a reopen event clears a block.
 */
import type { GroundReport, RoadEvent, RoadSegment, RoadState, Settlement, SettlementWarning } from '../../../shared/types.js';
import type { ConfirmedClosure } from './assess.js';
import { GROUND } from './config.js';
import { haversineM, pointToPolylineM } from './geo.js';
import { levelRank } from './levels.js';
import { ms } from './time.js';

const AT_RISK_RADIUS_M = 3000;
const BLOCK_KINDS = new Set(['road_flooded', 'bridge_submerged', 'vehicles_cannot_pass']);

export interface RoadInputs {
  segments: RoadSegment[];
  reports: GroundReport[];
  events: RoadEvent[];
  settlements: Settlement[];
  warnings: Map<string, SettlementWarning>;
  now: number;
}

const mid = (s: RoadSegment) => {
  const c = s.coords[Math.floor(s.coords.length / 2)];
  return { lat: c[0], lng: c[1] };
};

function reportSaysBlocked(r: GroundReport) {
  return r.evidence.road_blocked || r.evidence.kinds.some((k) => BLOCK_KINDS.has(k));
}
function reportSaysOpen(r: GroundReport) {
  return !reportSaysBlocked(r) && r.evidence.kinds.includes('road_open');
}

/** Returns only non-OPEN roads (everything missing from the map is OPEN). */
export function computeRoadStates(inp: RoadInputs): Map<string, RoadState> {
  const out = new Map<string, RoadState>();
  const set = (st: RoadState) => {
    const cur = out.get(st.segment_id);
    if (!cur || (cur.status !== 'BLOCKED' && st.status === 'BLOCKED')) out.set(st.segment_id, st);
  };

  // 1. Flood-prone segments near settlements at WARNING or above.
  const warned = inp.settlements.filter((s) => levelRank(inp.warnings.get(s.id)?.level ?? 'NONE') >= levelRank('WARNING'));
  if (warned.length) {
    for (const seg of inp.segments) {
      if (!seg.flood_prone) continue;
      const m = mid(seg);
      const near = warned.find((s) => haversineM(m, s) <= AT_RISK_RADIUS_M);
      if (near) {
        set({
          segment_id: seg.id, status: 'AT_RISK', mode: 'static', since: null,
          reason: `${seg.flood_prone_reason ?? 'Flood-prone segment'}; ${near.name} is at ${inp.warnings.get(near.id)!.level}`,
          source: 'flood engine (terrain + warning level)',
        });
      }
    }
  }

  // 2. Ground reports about roads (newest decides per segment).
  const roadReports = inp.reports
    .filter((r) => ms(r.received_at) <= inp.now && r.verification !== 'disputed' && (reportSaysBlocked(r) || reportSaysOpen(r)))
    .sort((a, b) => ms(a.received_at) - ms(b.received_at));
  const byReport = new Map<string, RoadState | 'open'>();
  for (const r of roadReports) {
    for (const seg of inp.segments) {
      if (haversineM(mid(seg), r) > 2000 + seg.length_m / 2) continue;
      if (pointToPolylineM(r, seg.coords) > GROUND.road_match_m) continue;
      if (reportSaysOpen(r)) {
        if (r.verification !== 'unverified') byReport.set(seg.id, 'open');
        continue;
      }
      const confirmed = r.verification === 'verified' || r.verification === 'corroborated';
      byReport.set(seg.id, {
        segment_id: seg.id, status: confirmed ? 'BLOCKED' : 'AT_RISK', since: r.received_at, mode: r.mode,
        reason: confirmed ? `${r.verification} ground report: road impassable` : 'Unverified report of flooded road — verification needed',
        source: `ground report ${r.id}`,
      });
    }
  }
  for (const [id, st] of byReport) {
    if (st === 'open') { if (out.get(id)?.source.startsWith('ground report')) out.delete(id); continue; }
    set(st);
  }

  // 3. Explicit closure / reopen events (latest per segment wins over reports).
  const latest = new Map<string, RoadEvent>();
  for (const e of inp.events) {
    if (ms(e.at) > inp.now) continue;
    const cur = latest.get(e.segment_id);
    if (!cur || ms(e.at) >= ms(cur.at)) latest.set(e.segment_id, e);
  }
  for (const e of latest.values()) {
    if (e.action === 'reopen') {
      if (out.get(e.segment_id)?.status === 'BLOCKED') out.delete(e.segment_id);
      continue;
    }
    out.set(e.segment_id, {
      segment_id: e.segment_id, status: 'BLOCKED', reason: e.reason, since: e.at, mode: e.mode,
      source: `${e.origin}: ${e.source}`,
    });
  }
  return out;
}

/** Confirmed closures (BLOCKED) within the ground-report radius of a settlement — used as warning evidence. */
export function closuresNear(s: Settlement, roads: Map<string, RoadState>, segById: Map<string, RoadSegment>) {
  const res: ConfirmedClosure[] = [];
  for (const st of roads.values()) {
    if (st.status !== 'BLOCKED') continue;
    const seg = segById.get(st.segment_id);
    if (!seg || pointToPolylineM(s, seg.coords) > GROUND.radius_m) continue;
    res.push({ segment_id: seg.id, name: seg.name, reason: st.reason, origin: st.source, mode: st.mode, since: st.since });
  }
  return res;
}
