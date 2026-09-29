/**
 * Step 4 — historical hourly rainfall from the Open-Meteo Historical Weather API (ERA5 reanalysis).
 * No API key. Licence: CC BY 4.0 (Open-Meteo), ERA5 © ECMWF / Copernicus Climate Change Service.
 *
 * Why ERA5 and not ERA5-Land: checked on 29 Sep 2026 — Open-Meteo returned no ERA5-Land precipitation
 * for Kolhapur (0/48 values for 22–23 Jul 2021), while ERA5 returned complete hourly values. ERA5 is a
 * 0.25° (~28 km) grid, so neighbouring 0.1° cells share the nearest ERA5 grid value.
 *
 * IMPORTANT: this is REANALYSIS (a model re-run constrained by observations), not rain-gauge data.
 * It is known to smooth and under-estimate extreme local rainfall over the Western Ghats.
 *
 * Writes, for each candidate flood event and for the evaluation seasons:
 *   data/kolhapur/replay/<event>/rainfall.json   hourly observations with ORIGINAL timestamps (IST)
 *   data/kolhapur/history/rainfall-<year>.json   monsoon seasons for false-alert evaluation
 *
 *   npm run data:rainfall
 */
import { join } from 'node:path';
import type { RainObservation } from '../../shared/types.js';
import { BUILT, fetchJson, loadJson, saveJson, sleep } from './common.js';

const URL_BASE = 'https://archive-api.open-meteo.com/v1/archive';
const MODEL = 'era5';
const SOURCE = 'Open-Meteo Historical Weather API — ERA5 reanalysis (0.25°)';
const LICENCE = 'CC BY 4.0 (Open-Meteo); ERA5 © ECMWF / Copernicus Climate Change Service';

/** Candidate replay events. Windows start 4 days early so antecedent (72 h) rain is available. */
export const EVENTS = [
  { id: 'kop-2019-08', name: 'Kolhapur floods — August 2019', start: '2019-07-28', end: '2019-08-12' },
  { id: 'kop-2021-07', name: 'Kolhapur floods — July 2021', start: '2021-07-15', end: '2021-07-27' },
];
/** Monsoon seasons for the false-alert evaluation (a subset of cells keeps the files small). */
const HISTORY_YEARS = Array.from({ length: 14 }, (_, i) => 2010 + i);
const HISTORY_CELLS = 8;

interface Cell { id: string; lat: number; lng: number }
interface ArchiveResponse { latitude: number; longitude: number; elevation?: number; hourly?: { time: string[]; precipitation: (number | null)[] } }

async function fetchCells(cells: Cell[], start: string, end: string): Promise<RainObservation[]> {
  const out: RainObservation[] = [];
  for (let i = 0; i < cells.length; i += 20) {
    const chunk = cells.slice(i, i + 20);
    const params = new URLSearchParams({
      latitude: chunk.map((c) => c.lat).join(','), longitude: chunk.map((c) => c.lng).join(','),
      start_date: start, end_date: end, hourly: 'precipitation', timezone: 'Asia/Kolkata', models: MODEL,
    });
    const res = await fetchJson<ArchiveResponse | ArchiveResponse[]>(`${URL_BASE}?${params}`);
    const list = Array.isArray(res) ? res : [res];
    list.forEach((r, j) => {
      const cell = chunk[j];
      const h = r.hourly;
      if (!h) return;
      h.time.forEach((t, k) => {
        const v = h.precipitation[k];
        out.push({
          cell_id: cell.id, lat: cell.lat, lng: cell.lng,
          // Open-Meteo hourly precipitation is the sum over the PRECEDING hour; `t` is local (IST) time.
          observed_at: `${t}:00+05:30`, interval_min: 60,
          rainfall_mm: typeof v === 'number' && Number.isFinite(v) ? v : null, source: SOURCE, mode: 'replay',
        });
      });
    });
    await sleep(8000); // archive calls are weighted by locations × date range; stay well under ~600 per minute
  }
  return out;
}

function dailySummary(obs: RainObservation[]) {
  const byDay = new Map<string, { sum: number; n: number; cells: Set<string>; max: number }>();
  for (const o of obs) {
    if (o.rainfall_mm === null) continue;
    const day = o.observed_at.slice(0, 10);
    const d = byDay.get(day) ?? { sum: 0, n: 0, cells: new Set(), max: 0 };
    d.sum += o.rainfall_mm; d.n++; d.cells.add(o.cell_id); d.max = Math.max(d.max, o.rainfall_mm);
    byDay.set(day, d);
  }
  return [...byDay.entries()].map(([day, d]) => ({
    day, mean_cell_total_mm: Math.round((d.sum / d.cells.size) * 10) / 10, max_hourly_mm: Math.round(d.max * 10) / 10, cells: d.cells.size,
  }));
}

async function main() {
  const cells = loadJson<Cell[]>(join(BUILT, 'rain_cells.json'));
  console.log(`${cells.length} rain cells`);
  for (const ev of EVENTS) {
    console.log(`Event ${ev.id} (${ev.start} → ${ev.end}) …`);
    const obs = await fetchCells(cells, ev.start, ev.end);
    const missing = obs.filter((o) => o.rainfall_mm === null).length;
    if (missing > obs.length * 0.2) throw new Error(`${ev.id}: ${missing} of ${obs.length} rainfall values missing — refusing to write an unusable replay (check the model)`);
    const summary = dailySummary(obs);
    console.table(summary);
    saveJson(join(BUILT, 'replay', ev.id, 'rainfall.json'), {
      meta: {
        event_id: ev.id, event_name: ev.name, fetched_at: new Date().toISOString(), source: SOURCE, licence: LICENCE,
        url: URL_BASE, model: MODEL, period: { start: ev.start, end: ev.end, timezone: 'Asia/Kolkata' },
        observations: obs.length, missing_values: missing,
        limitations: 'Reanalysis, not gauge observations; ~28 km (0.25°) grid, so nearby cells share values; under-estimates extreme local rainfall.',
      },
      daily_summary: summary,
      observations: obs,
    });
  }
  // Evaluation history: cells nearest the district centre of mass of settlements.
  const mean = cells.reduce((a, c) => ({ lat: a.lat + c.lat / cells.length, lng: a.lng + c.lng / cells.length }), { lat: 0, lng: 0 });
  const histCells = [...cells].sort((a, b) => Math.hypot(a.lat - mean.lat, a.lng - mean.lng) - Math.hypot(b.lat - mean.lat, b.lng - mean.lng)).slice(0, HISTORY_CELLS);
  for (const y of HISTORY_YEARS) {
    console.log(`History ${y} (Jun–Sep) …`);
    const obs = await fetchCells(histCells, `${y}-06-01`, `${y}-09-30`);
    saveJson(join(BUILT, 'history', `rainfall-${y}.json`), {
      meta: { year: y, fetched_at: new Date().toISOString(), source: SOURCE, licence: LICENCE, model: MODEL, cells: histCells.map((c) => c.id) },
      observations: obs,
    });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
