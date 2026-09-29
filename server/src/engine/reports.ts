/**
 * Ground-report verification state.
 *  - verified / disputed: set by a coordinator (always wins)
 *  - corroborated: automatic, when reports from ≥2 different reporters agree within 800 m and 2 h
 *  - unverified: everything else
 */
import type { GroundReport, Verification } from '../../../shared/types.js';
import { GROUND } from './config.js';
import { haversineM } from './geo.js';
import { reportStance } from './assess.js';
import { MIN, ms } from './time.js';

export function applyVerification(
  reports: GroundReport[],
  decisions: Map<string, Extract<Verification, 'verified' | 'disputed'>>,
  now: number,
): GroundReport[] {
  const visible = reports.filter((r) => ms(r.received_at) <= now);
  return visible.map((r) => {
    const decided = decisions.get(r.id);
    if (decided) return { ...r, verification: decided };
    const stance = reportStance(r);
    if (stance === 'neutral') return { ...r, verification: 'unverified' };
    const reporters = new Set<string>([r.reporter_ref]);
    for (const o of visible) {
      if (o.id === r.id || decisions.get(o.id) === 'disputed' || reportStance(o) !== stance) continue;
      if (Math.abs(ms(o.received_at) - ms(r.received_at)) > GROUND.corroboration_window_min * MIN) continue;
      if (haversineM(r, o) > GROUND.corroboration_radius_m) continue;
      reporters.add(o.reporter_ref);
    }
    return { ...r, verification: reporters.size >= GROUND.corroboration_count ? 'corroborated' : 'unverified' };
  });
}
