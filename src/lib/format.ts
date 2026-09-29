import type { AccessStatus, DataMode, PriorityBand, RoadStatus, WarningLevel } from '../../shared/types';

const IST = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const IST_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

/** "22 Jul 2021, 14:00 IST" */
export const istDateTime = (t: string | number | null | undefined) => (t == null ? '—' : `${IST.format(new Date(t))} IST`);
export const istTime = (t: string | number | null | undefined) => (t == null ? '—' : IST_TIME.format(new Date(t)));

export function age(min: number | null | undefined): string {
  if (min == null) return 'no data';
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min old`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${min % 60} min old` : `${Math.floor(h / 24)} days old`;
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;

export const LEVEL_STYLE: Record<WarningLevel, { label: string; cls: string; color: string }> = {
  SEVERE: { label: 'SEVERE', cls: 'bg-severe/15 text-red-300 border-severe/60', color: '#ef4444' },
  WARNING: { label: 'WARNING', cls: 'bg-warning/15 text-amber-300 border-warning/60', color: '#f59e0b' },
  WATCH: { label: 'WATCH', cls: 'bg-watch/10 text-yellow-200 border-watch/50', color: '#eab308' },
  NONE: { label: 'No warning', cls: 'bg-none/20 text-ink-3 border-line', color: '#475569' },
};

export const BAND_STYLE: Record<PriorityBand, string> = {
  CRITICAL: 'text-red-300', HIGH: 'text-amber-300', MEDIUM: 'text-yellow-200', LOW: 'text-ink-3',
};

export const ACCESS_STYLE: Record<AccessStatus, { label: string; cls: string }> = {
  REACHABLE: { label: 'Reachable', cls: 'text-emerald-300' },
  DEGRADED: { label: 'Degraded', cls: 'text-amber-300' },
  CUT_OFF: { label: 'CUT OFF', cls: 'text-red-300 font-semibold' },
  UNKNOWN: { label: 'No road data', cls: 'text-ink-3' },
};

export const ROAD_STYLE: Record<RoadStatus, { label: string; color: string }> = {
  OPEN: { label: 'Open', color: '#22c55e' },
  AT_RISK: { label: 'At risk', color: '#f59e0b' },
  BLOCKED: { label: 'Blocked', color: '#ef4444' },
};

export const MODE_LABEL: Record<DataMode | 'static', string> = {
  live: 'LIVE', replay: 'REPLAY', synthetic_scenario: 'SYNTHETIC SCENARIO', static: 'STATIC DATASET',
};
