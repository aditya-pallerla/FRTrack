/**
 * Terrain susceptibility (0..1): a simplified height-above-nearest-drainage (HAND) proxy.
 * Low ground close to a river is MORE SUSCEPTIBLE to flooding. It never guarantees flooding.
 */
import { TERRAIN } from './config.js';
import { clamp01 } from './geo.js';

export function terrainSusceptibility(heightAboveRiverM: number | null, distanceToRiverM: number | null): number | null {
  if (heightAboveRiverM === null || distanceToRiverM === null) return null;
  const hand = clamp01((TERRAIN.hand_zero_m - heightAboveRiverM) / (TERRAIN.hand_zero_m - TERRAIN.hand_full_m));
  const proximity = clamp01(1 - distanceToRiverM / TERRAIN.river_distance_zero_m);
  return Math.round((0.7 * hand + 0.3 * proximity) * 100) / 100;
}
