import { useState } from 'react';
import type { Situation } from '../../shared/types';
import { api } from '../lib/api';
import { istTime } from '../lib/format';
import { useStore } from '../store';
import { RecommendationCard } from './SettlementDetail';
import { Button, SectionTitle, Tag, cx } from './ui';

const CHANGE_TONE: Record<string, string> = {
  warning_escalated: 'text-red-300', warning_created: 'text-amber-300', warning_downgraded: 'text-emerald-300',
  settlement_cut_off: 'text-red-300', road_status_changed: 'text-amber-200', route_invalidated: 'text-amber-300',
  alternate_route_found: 'text-sky-300', priority_changed: 'text-ink', recommendation_changed: 'text-purple-300', verification_requested: 'text-purple-300',
};

export function Overview() {
  const geo = useStore((s) => s.geo)!;
  const sit = useStore((s) => s.situation)!;
  const log = useStore((s) => s.log);
  const user = useStore((s) => s.user);
  const select = useStore((s) => s.select);
  const setSituation = useStore((s) => s.setSituation);
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState<string | null>(null);
  const staff = user?.role === 'admin' || user?.role === 'coordinator';
  const name = (id: string) => geo.settlements.find((s) => s.id === id)?.name ?? id;
  const unit = (id: string) => sit.units.find((u) => u.id === id)?.name ?? id;
  const count = (l: string) => sit.warnings.filter((w) => w.level === l).length;
  const blocked = sit.roads.filter((r) => r.status === 'BLOCKED');
  const cut = sit.access.filter((a) => a.status === 'CUT_OFF' && sit.warnings.find((w) => w.settlement_id === a.settlement_id)?.level !== 'NONE');
  const verify = sit.warnings.filter((w) => w.verification_requested);

  async function act(key: string, fn: () => Promise<Situation>, ok: string) {
    setBusy(key);
    try { setSituation(await fn()); notify('ok', ok); } catch (e) { notify('error', (e as Error).message); } finally { setBusy(null); }
  }

  const stat = (label: string, value: number, cls: string) => (
    <div className="rounded-md border border-line bg-panel-2/60 px-2 py-1.5"><p className={cx('text-xl font-semibold tabular-nums', cls)}>{value}</p><p className="text-[11px] text-ink-3">{label}</p></div>
  );

  return (
    <div className="p-3 space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {stat('Severe', count('SEVERE'), 'text-red-300')}
        {stat('Warning', count('WARNING'), 'text-amber-300')}
        {stat('Watch', count('WATCH'), 'text-yellow-200')}
        {stat('Cut off', cut.length, cut.length ? 'text-red-300' : 'text-ink')}
        {stat('Roads blocked', blocked.length, blocked.length ? 'text-red-300' : 'text-ink')}
        {stat('To verify', verify.length, verify.length ? 'text-purple-300' : 'text-ink')}
      </div>

      <section>
        <SectionTitle right={<Tag>{sit.recommendations.length} pending</Tag>}>Recommended actions</SectionTitle>
        {sit.recommendations.length === 0 && <p className="text-xs text-ink-3">No pending recommendations.</p>}
        <div className="space-y-2">
          {sit.recommendations.map((r) => <RecommendationCard key={r.id} r={r} unit={unit(r.unit_id)} settlementName={name(r.settlement_id)} staff={staff} busy={busy} onAct={act} />)}
        </div>
        {sit.unmet.length > 0 && (
          <div className="mt-2 text-xs rounded-md border border-line p-2">
            <p className="text-ink-3 mb-1">Needs not covered ({sit.unmet.length})</p>
            <ul className="space-y-0.5">{sit.unmet.slice(0, 8).map((u, i) => <li key={i}><button className="underline decoration-dotted" onClick={() => select(u.settlement_id)}>{name(u.settlement_id)}</button>: {u.need} — {u.reason}</li>)}</ul>
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Road closures</SectionTitle>
        {blocked.length === 0 && <p className="text-xs text-ink-3">No roads blocked.</p>}
        <ul className="space-y-1.5">
          {blocked.map((r) => (
            <li key={r.segment_id} className="text-xs rounded border border-severe/40 bg-severe/5 p-2">
              <p className="font-medium">{geo.roads.find((x) => x.id === r.segment_id)?.name ?? 'Unnamed road'} <span className="text-ink-3 font-normal">({r.segment_id})</span></p>
              <p className="text-ink-2">{r.reason}</p>
              <p className="text-ink-3">Source: {r.source}{r.since ? ` · since ${istTime(r.since)}` : ''}</p>
              {staff && r.source.startsWith('coordinator') && (
                <Button size="sm" className="mt-1" disabled={!!busy} onClick={() => act(`o${r.segment_id}`, () => api(`/api/roads/${r.segment_id}`, { body: { action: 'reopen', reason: 'Reopened by coordinator' } }), 'Road reopened')}>Reopen</Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <SectionTitle>What changed</SectionTitle>
        {log.length === 0 && <p className="text-xs text-ink-3">Changes will appear here as conditions evolve.</p>}
        <ol className="space-y-1">
          {log.slice(0, 60).map((c, i) => (
            <li key={i} className="text-xs flex gap-2">
              <span className="text-ink-3 tabular-nums shrink-0">{istTime(c.at)}</span>
              <button className={cx('text-left', CHANGE_TONE[c.type] ?? 'text-ink-2')} onClick={() => c.settlement_id && select(c.settlement_id)}>{c.message}</button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
