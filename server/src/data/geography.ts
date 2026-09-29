/** Loads the bundled Kolhapur geography built by `npm run data:all` (data/kolhapur). */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResponseBase, RiverGauge, RoadSegment, Settlement, Unit } from '../../../shared/types.js';

export const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data/kolhapur');

function read<T>(file: string): T {
  const p = join(DATA_DIR, file);
  if (!existsSync(p)) throw new Error(`Missing data/kolhapur/${file}. Build the dataset first: npm run data:all`);
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

export interface Geography {
  settlements: Settlement[];
  segments: RoadSegment[];
  bases: ResponseBase[];
  units: Unit[];
  gauges: RiverGauge[];
  rivers: { name: string; coords: [number, number][] }[];
  boundary: [number, number][][];
  meta: Record<string, unknown>;
}

export function loadGeography(): Geography {
  return {
    settlements: read('settlements.json'),
    segments: read('roads.json'),
    bases: read('bases.json'),
    units: read('units.json'),
    gauges: read('gauges.json'),
    rivers: read('rivers.json'),
    boundary: read('boundary.json'),
    meta: read('build-meta.json'),
  };
}

export const hasGeography = () => existsSync(join(DATA_DIR, 'build-meta.json'));
