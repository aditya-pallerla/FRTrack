/**
 * Step 2 — terrain elevations from the Open-Meteo Elevation API (Copernicus DEM GLO-90, ~90 m).
 * No API key. Licence: Open-Meteo data CC BY 4.0; Copernicus DEM © DLR/Airbus, provided under the
 * Copernicus programme licence (free use with attribution).
 *
 * Samples only what the engine needs: settlements in scope, points every 500 m along rivers, and the
 * middles of road segments close to a river.
 *
 *   npm run data:elevation
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RAW, fetchJson, loadJson, saveJson, sleep, type RawMeta } from './common.js';
import {
  PointIndex, ROAD_RIVER_RADIUS_M, midpoint, places, pointKey, riverSamples, rivers, roadSegments, settlementCandidates,
} from './osm.js';

const URL_BASE = 'https://api.open-meteo.com/v1/elevation';
const BATCH = 100;

async function main() {
  const rs = rivers();
  const samples = riverSamples(rs);
  const riverIdx = new PointIndex(samples);
  const settlements = settlementCandidates(places(), riverIdx);
  const roadMids = roadSegments().map(midpoint).filter((m) => riverIdx.nearest(m, ROAD_RIVER_RADIUS_M) !== null);
  const points = new Map<string, { lat: number; lng: number }>();
  for (const p of [...settlements, ...samples, ...roadMids]) points.set(pointKey(p), { lat: Number(p.lat.toFixed(5)), lng: Number(p.lng.toFixed(5)) });
  console.log(`Elevation for ${points.size} points (${settlements.length} settlements, ${samples.length} river samples, ${roadMids.length} road points)`);

  // Resume support: keep values from an earlier (partial) run.
  const outPath = join(RAW, 'elevation.json');
  const out: Record<string, number | null> = existsSync(outPath) ? loadJson<{ elevation_m: Record<string, number | null> }>(outPath).elevation_m : {};
  const list = [...points.entries()].filter(([k]) => !(k in out));
  console.log(`  ${Object.keys(out).length} already cached, ${list.length} to fetch`);
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const url = `${URL_BASE}?latitude=${chunk.map(([, p]) => p.lat).join(',')}&longitude=${chunk.map(([, p]) => p.lng).join(',')}`;
    const res = await fetchJson<{ elevation: (number | null)[] }>(url);
    chunk.forEach(([k], j) => {
      const v = res.elevation?.[j];
      out[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
    });
    process.stdout.write(`\r  ${Math.min(i + BATCH, list.length)}/${list.length}`);
    if ((i / BATCH) % 5 === 4) saveJson(outPath, { meta: { partial: true }, elevation_m: out });
    // Free tier counts each coordinate as a call (~600/min): 100 coordinates every 12 s stays under it.
    await sleep(12_000);
  }
  console.log();
  const meta: RawMeta = {
    fetched_at: new Date().toISOString(), source: 'Open-Meteo Elevation API (Copernicus DEM GLO-90)', url: URL_BASE,
    licence: 'Open-Meteo CC BY 4.0; Copernicus DEM GLO-90 © DLR e.V. / Airbus, Copernicus programme',
    params: { resolution: '~90 m', points: Object.keys(out).length },
  };
  saveJson(outPath, { meta, elevation_m: out });
}

main().catch((err) => { console.error(err); process.exit(1); });
