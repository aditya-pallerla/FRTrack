import type { WarningLevel } from '../../../shared/types.js';
import { WARNING_LEVELS } from '../../../shared/types.js';
import type { WindowThreshold } from './config.js';

export const levelRank = (l: WarningLevel) => WARNING_LEVELS.indexOf(l);
export const maxLevel = (a: WarningLevel, b: WarningLevel) => (levelRank(a) >= levelRank(b) ? a : b);
export const minLevel = (a: WarningLevel, b: WarningLevel) => (levelRank(a) <= levelRank(b) ? a : b);

/**
 * Maps a value onto a 0..1 severity index against watch / warning / severe thresholds:
 *   0 → watch = 0..⅓,  watch → warning = ⅓..⅔,  warning → severe = ⅔..1,  ≥ severe = 1.
 */
export function severityIndex(value: number, t: Pick<WindowThreshold, 'watch' | 'warning' | 'severe'>): number {
  if (value <= 0) return 0;
  if (value < t.watch) return (value / t.watch) / 3;
  if (value < t.warning) return 1 / 3 + ((value - t.watch) / (t.warning - t.watch)) / 3;
  if (value < t.severe) return 2 / 3 + ((value - t.warning) / (t.severe - t.warning)) / 3;
  return 1;
}

/** Level implied by a severity index alone. */
export function levelOfIndex(idx: number): WarningLevel {
  if (idx >= 1) return 'SEVERE';
  if (idx >= 2 / 3) return 'WARNING';
  if (idx >= 1 / 3) return 'WATCH';
  return 'NONE';
}

/** Freshness factor: 1 while fresh, falling linearly to 0 at the stale limit. */
export function freshnessFactor(ageMin: number | null, limits: { fresh: number; stale: number }): number {
  if (ageMin === null) return 0;
  if (ageMin <= limits.fresh) return 1;
  if (ageMin >= limits.stale) return 0;
  return 1 - (ageMin - limits.fresh) / (limits.stale - limits.fresh);
}
