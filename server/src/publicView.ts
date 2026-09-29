/**
 * Public-safe view for citizens: warning level and area, closed roads, safety advice.
 * Never includes risk scores, confidence internals, allocations, unit names, reporters or audit data.
 */
import type { Situation, WarningLevel } from '../../shared/types.js';
import type { Geography } from './data/geography.js';

export interface PublicStatus {
  mode: Situation['mode'] | null;
  replay: { event_name: string; original_time: string } | null;
  as_of: string | null;
  highest_level: WarningLevel;
  /** Number of settlements at each level (WATCH is shown as a count only). */
  counts: { SEVERE: number; WARNING: number; WATCH: number };
  areas: { settlement_id: string; name: string; name_mr: string | null; level: WarningLevel; lat: number; lng: number; road_access: string }[];
  closed_roads: { name: string; pieces: [number, number][][] }[];
  advice: string[];
  shelter_note: string;
}

const RANK: Record<WarningLevel, number> = { NONE: 0, WATCH: 1, WARNING: 2, SEVERE: 3 };

const ADVICE: Record<WarningLevel, string[]> = {
  NONE: ['No flood warning for your area right now.', 'Keep emergency numbers handy: 112 (emergency), 1077 (district disaster control room).'],
  WATCH: ['Stay alert and follow official announcements.', 'Keep documents, medicines, drinking water and a torch ready.', 'Avoid river banks, causeways and low bridges.'],
  WARNING: ['Prepare to move to higher ground if told to.', 'Do not walk or drive through flood water — 30 cm of moving water can sweep a vehicle away.', 'Switch off electricity at the main if water enters your home.', 'Help children, elderly and disabled neighbours.'],
  SEVERE: ['Move to higher ground now if you are in a low-lying area.', 'Do not cross flooded roads or bridges.', 'If trapped, go to the highest floor or roof and signal for help. Call 112.', 'Report people trapped with the "Report flooding" button.'],
};

export function publicStatus(s: Situation | null, geo: Geography): PublicStatus {
  const names = new Map(geo.settlements.map((x) => [x.id, x]));
  const segs = new Map(geo.segments.map((x) => [x.id, x]));
  const access = new Map((s?.access ?? []).map((a) => [a.settlement_id, a.status]));
  const counts = { SEVERE: 0, WARNING: 0, WATCH: 0 };
  for (const w of s?.warnings ?? []) if (w.level !== 'NONE') counts[w.level]++;
  // Citizens see WARNING and SEVERE areas individually; WATCH (monitoring) is summarised as a count.
  const areas = (s?.warnings ?? []).filter((w) => w.level === 'WARNING' || w.level === 'SEVERE').map((w) => {
    const st = names.get(w.settlement_id)!;
    const a = access.get(w.settlement_id);
    return {
      settlement_id: w.settlement_id, name: st.name, name_mr: st.name_mr ?? null, level: w.level, lat: st.lat, lng: st.lng,
      road_access: a === 'CUT_OFF' ? 'No road access' : a === 'DEGRADED' ? 'Roads disrupted — use detours' : 'Roads open',
    };
  }).sort((a, b) => RANK[b.level] - RANK[a.level] || a.name.localeCompare(b.name));
  const highest: WarningLevel = counts.SEVERE ? 'SEVERE' : counts.WARNING ? 'WARNING' : counts.WATCH ? 'WATCH' : 'NONE';
  return {
    mode: s?.mode ?? null,
    replay: s?.replay ? { event_name: s.replay.event_name, original_time: s.replay.original_time } : null,
    as_of: s?.as_of ?? null,
    highest_level: highest,
    counts,
    areas,
    closed_roads: closedRoads(s, segs),
    advice: ADVICE[highest],
    shelter_note: 'Verified shelter locations and capacity are not available in this prototype. Follow instructions from local officials.',
  };
}

/** Blocked segments grouped by road name (one entry per road, all its closed pieces drawn). */
function closedRoads(s: Situation | null, segs: Map<string, Geography['segments'][number]>) {
  const byName = new Map<string, [number, number][][]>();
  for (const r of s?.roads ?? []) {
    if (r.status !== 'BLOCKED') continue;
    const seg = segs.get(r.segment_id);
    if (!seg) continue;
    const name = seg.name ?? 'Unnamed road';
    byName.set(name, [...(byName.get(name) ?? []), seg.coords]);
  }
  return [...byName.entries()].map(([name, pieces]) => ({ name, pieces }));
}
