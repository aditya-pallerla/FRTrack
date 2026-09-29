/**
 * Rainfall aggregation for one grid cell at the engine clock.
 *
 * Observations are interval totals whose `observed_at` is the END of the interval. A window of H hours
 * at time `now` sums every observation with observed_at in (now − H, now]. Observations after `now` are
 * never used (no look-ahead during replay). Missing values are counted and reported, never filled.
 */
import type { RainObservation } from '../../../shared/types.js';
import { HOUR, ms } from './time.js';

export interface WindowSum {
  hours: number;
  /** null when no usable observation exists in the window. */
  mm: number | null;
  expected: number;
  present: number;
  missing: number;
}

export interface CellRainfall {
  cell_id: string;
  rain_1h: WindowSum;
  rain_3h: WindowSum;
  rain_6h: WindowSum;
  rain_24h: WindowSum;
  /** Rain in the 72 h BEFORE the last 24 h (antecedent wetness). */
  antecedent_72h: WindowSum;
  /** Last 3 h minus the 3 h before it (mm). null if either part is missing. */
  trend_3h_mm: number | null;
  latest_observed_at: string | null;
  source: string | null;
  mode: RainObservation['mode'] | null;
}

function sumWindow(obs: RainObservation[], from: number, to: number, intervalMin: number): WindowSum {
  const hours = (to - from) / HOUR;
  const inWindow = obs.filter((o) => { const t = ms(o.observed_at); return t > from && t <= to; });
  const expected = Math.max(1, Math.round((hours * 60) / intervalMin));
  const values = inWindow.map((o) => o.rainfall_mm).filter((v): v is number => v !== null && Number.isFinite(v));
  const present = values.length;
  return {
    hours,
    mm: present ? Math.round(values.reduce((a, b) => a + b, 0) * 10) / 10 : null,
    expected,
    present,
    missing: Math.max(0, expected - present),
  };
}

/** Aggregates one cell's observations at time `now` (epoch ms). `obs` may contain any cells/times. */
export function aggregateCell(cellId: string, allObs: RainObservation[], now: number): CellRainfall {
  const obs = allObs.filter((o) => o.cell_id === cellId && ms(o.observed_at) <= now);
  const interval = obs[0]?.interval_min ?? 60;
  const w = (h: number) => sumWindow(obs, now - h * HOUR, now, interval);
  const last3 = w(3);
  const prev3 = sumWindow(obs, now - 6 * HOUR, now - 3 * HOUR, interval);
  // Freshness is measured from the latest observation that actually has a value.
  const latest = obs.filter((o) => o.rainfall_mm !== null)
    .reduce<RainObservation | null>((best, o) => (!best || ms(o.observed_at) > ms(best.observed_at) ? o : best), null);
  return {
    cell_id: cellId,
    rain_1h: w(1),
    rain_3h: last3,
    rain_6h: w(6),
    rain_24h: w(24),
    antecedent_72h: sumWindow(obs, now - 96 * HOUR, now - 24 * HOUR, interval),
    trend_3h_mm: last3.mm !== null && prev3.mm !== null ? Math.round((last3.mm - prev3.mm) * 10) / 10 : null,
    latest_observed_at: latest?.observed_at ?? null,
    source: latest?.source ?? null,
    mode: latest?.mode ?? null,
  };
}
