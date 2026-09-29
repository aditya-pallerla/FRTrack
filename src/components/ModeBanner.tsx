import { useEffect, useState } from 'react';
import { History, Radio, TriangleAlert } from 'lucide-react';
import type { Situation } from '../../shared/types';
import { age, istDateTime } from '../lib/format';
import { cx } from './ui';

/**
 * Always-visible data-mode banner. In REPLAY it shows the ORIGINAL event time and, separately,
 * the time the replay is being run — so replayed data can never be mistaken for live data.
 */
export function ModeBanner({ situation, liveError, compact = false }: { situation: Situation | null; liveError?: string | null; compact?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  if (!situation) return <div className="px-3 py-1.5 text-xs text-ink-3 border border-line rounded-md">Loading situation…</div>;
  if (situation.mode === 'replay') {
    const r = situation.replay;
    return (
      <div role="status" className={cx('flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border-2 border-replay bg-replay/15 text-blue-100', compact ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm')}>
        <span className="flex items-center gap-1.5 font-bold tracking-wide"><History className="w-4 h-4" aria-hidden /> REPLAY — HISTORICAL EVENT</span>
        {r && <span className="font-medium">{r.event_name}</span>}
        <span>Original time: <b className="tabular-nums">{istDateTime(situation.as_of)}</b></span>
        {!compact && <span className="text-blue-200/80">Replayed at: <span className="tabular-nums">{istDateTime(now)}</span></span>}
        <span className="font-bold text-white bg-replay rounded px-1.5">NOT LIVE DATA</span>
      </div>
    );
  }
  const stale = situation.freshness.rain_stale;
  return (
    <div role="status" className={cx('flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border-2', stale || liveError ? 'border-warning bg-warning/10 text-amber-100' : 'border-live bg-live/10 text-emerald-100', compact ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm')}>
      <span className="flex items-center gap-1.5 font-bold tracking-wide"><Radio className="w-4 h-4" aria-hidden /> LIVE DATA</span>
      <span>Updated: <b className="tabular-nums">{istDateTime(situation.as_of)}</b></span>
      <span>Rainfall: {age(situation.freshness.rain_age_min)} (model nowcast, not gauges)</span>
      {(stale || liveError) && <span className="flex items-center gap-1 font-semibold"><TriangleAlert className="w-4 h-4" aria-hidden /> {liveError ?? 'DATA STALE'}</span>}
    </div>
  );
}
