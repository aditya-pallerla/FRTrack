import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Search, ShieldQuestion } from 'lucide-react';
import { ACCESS_STYLE, BAND_STYLE } from '../lib/format';
import { useStore } from '../store';
import { LevelBadge, SectionTitle, cx } from './ui';

export function PriorityList() {
  const geo = useStore((s) => s.geo);
  const sit = useStore((s) => s.situation);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    if (!geo || !sit) return [];
    const names = new Map(geo.settlements.map((s) => [s.id, s]));
    const w = new Map(sit.warnings.map((x) => [x.settlement_id, x]));
    const a = new Map(sit.access.map((x) => [x.settlement_id, x]));
    return sit.priorities.map((p) => ({ p, s: names.get(p.settlement_id)!, w: w.get(p.settlement_id)!, a: a.get(p.settlement_id) }))
      .filter((r) => (showAll || r.w.level !== 'NONE' || r.w.verification_requested) && (!q || r.s.name.toLowerCase().includes(q.toLowerCase())));
  }, [geo, sit, q, showAll]);

  const warned = sit?.warnings.filter((w) => w.level !== 'NONE').length ?? 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-3 border-b border-line">
        <SectionTitle right={<span className="text-[11px] text-ink-3">{warned} under warning</span>}>Response priority</SectionTitle>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-ink-3" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find settlement" aria-label="Find settlement"
            className="w-full bg-panel-2 border border-line rounded pl-7 pr-2 py-1.5 text-sm placeholder:text-ink-3" />
        </div>
        <label className="flex items-center gap-2 mt-2 text-xs text-ink-2 cursor-pointer">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-accent" /> Show settlements without a warning
        </label>
      </div>
      <ol className="flex-1 overflow-y-auto scroll-thin p-2 space-y-1.5">
        {rows.length === 0 && <li className="text-sm text-ink-3 p-3">No settlement is under a flood warning at this time.</li>}
        {rows.map(({ p, s, w, a }) => {
          const moved = p.previous_rank != null ? p.previous_rank - p.rank : 0;
          return (
            <li key={s.id}>
              <button onClick={() => select(s.id)} aria-current={selected === s.id}
                className={cx('w-full text-left rounded-md border px-2.5 py-2 transition-colors', selected === s.id ? 'border-accent bg-accent/10' : 'border-line bg-panel-2/60 hover:border-line-strong')}>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-ink-3 tabular-nums w-6">#{p.rank}</span>
                  <span className="font-medium truncate flex-1">{s.name}</span>
                  {moved !== 0 && (
                    <span className={cx('flex items-center text-[11px] tabular-nums', moved > 0 ? 'text-red-300' : 'text-emerald-300')} title={`Rank ${p.previous_rank} → ${p.rank}`}>
                      {moved > 0 ? <ArrowUp className="w-3 h-3" aria-hidden /> : <ArrowDown className="w-3 h-3" aria-hidden />}{Math.abs(moved)}
                      <span className="sr-only">{moved > 0 ? 'moved up' : 'moved down'}</span>
                    </span>
                  )}
                  <LevelBadge level={w.level} />
                </div>
                <div className="flex items-center gap-3 mt-1 text-[11px] pl-8">
                  <span className={BAND_STYLE[p.band]}>{p.band} · {p.score}</span>
                  <span className={ACCESS_STYLE[a?.status ?? 'UNKNOWN'].cls}>{ACCESS_STYLE[a?.status ?? 'UNKNOWN'].label}</span>
                  <span className="text-ink-3">conf. {Math.round(w.confidence.value * 100)}%</span>
                  {w.verification_requested && <span className="flex items-center gap-0.5 text-purple-300" title="Verification requested"><ShieldQuestion className="w-3 h-3" aria-hidden />verify</span>}
                </div>
                {p.changes.length > 0 && <p className="text-[11px] text-ink-2 mt-1 pl-8 line-clamp-2">{p.changes.join(' · ')}</p>}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
