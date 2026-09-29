/**
 * LIVE rainfall: Open-Meteo Forecast API (no key; CC BY 4.0). We request the past 2 days of hourly
 * precipitation and keep ONLY hours that have already ended. These are weather-model values (analysis
 * and short-range forecast blend), not rain-gauge observations — labelled as such everywhere.
 */
import type { RainObservation } from '../../../shared/types.js';

const URL_BASE = 'https://api.open-meteo.com/v1/forecast';
export const LIVE_SOURCE = 'Open-Meteo Forecast API — model nowcast (not gauge observation)';

export interface Cell { id: string; lat: number; lng: number }

export async function fetchLiveRain(cells: Cell[], now = Date.now()): Promise<RainObservation[]> {
  const out: RainObservation[] = [];
  for (let i = 0; i < cells.length; i += 50) {
    const chunk = cells.slice(i, i + 50);
    const params = new URLSearchParams({
      latitude: chunk.map((c) => c.lat).join(','), longitude: chunk.map((c) => c.lng).join(','),
      hourly: 'precipitation', past_days: '4', forecast_days: '1', timezone: 'Asia/Kolkata',
    });
    const res = await fetch(`${URL_BASE}?${params}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Open-Meteo forecast HTTP ${res.status}`);
    const body = await res.json() as { hourly?: { time: string[]; precipitation: (number | null)[] } } | { hourly?: { time: string[]; precipitation: (number | null)[] } }[];
    const list = Array.isArray(body) ? body : [body];
    list.forEach((r, j) => {
      const cell = chunk[j];
      r.hourly?.time.forEach((t, k) => {
        const observedAt = `${t}:00+05:30`;
        if (Date.parse(observedAt) > now) return; // only completed hours
        const v = r.hourly!.precipitation[k];
        out.push({
          cell_id: cell.id, lat: cell.lat, lng: cell.lng, observed_at: observedAt, interval_min: 60,
          rainfall_mm: typeof v === 'number' && Number.isFinite(v) ? v : null, source: LIVE_SOURCE, mode: 'live',
        });
      });
    });
  }
  return out;
}
