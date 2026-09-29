import { useEffect, useState } from 'react';
import { Check, CircleAlert, CircleX, Clock, History, Route, ShieldCheck, ShieldX, TriangleAlert, X } from 'lucide-react';
import type { Recommendation, Situation } from '../../shared/types';
import { api } from '../lib/api';
import { ACCESS_STYLE, BAND_STYLE, MODE_LABEL, age, istDateTime, istTime } from '../lib/format';
import { useStore } from '../store';
import { RoadCloser } from './RoadCloser';
import { Button, LevelBadge, Meter, SectionTitle, Tag, cx } from './ui';

const COMPONENT_LABEL: Record<string, string> = {
  level: 'Warning level', exposure: 'Exposure (population)', vulnerability: 'Vulnerable people', rescue: 'Rescue reports', access: 'Access difficulty', trend: 'Rain trend',
};

export function SettlementDetail({ id }: { id: string }) {
  const geo = useStore((s) => s.geo)!;
  const sit = useStore((s) => s.situation)!;
  const user = useStore((s) => s.user);
  const select = useStore((s) => s.select);
  const setSituation = useStore((s) => s.setSituation);
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState<string | null>(null);

  const s = geo.settlements.find((x) => x.id === id);
  const w = sit.warnings.find((x) => x.settlement_id === id);
  const a = sit.access.find((x) => x.settlement_id === id);
  const p = sit.priorities.find((x) => x.settlement_id === id);
  if (!s || !w || !p) return null;
  const staff = user?.role === 'admin' || user?.role === 'coordinator';
  const reports = sit.reports.filter((r) => Math.hypot((r.lat - s.lat) * 111, (r.lng - s.lng) * 106) <= 2.5);
  const recs = sit.recommendations.filter((r) => r.settlement_id === id);
  const assignments = sit.assignments.filter((x) => x.settlement_id === id && x.status !== 'cancelled');
  const unitName = (uid: string) => sit.units.find((u) => u.id === uid)?.name ?? uid;
  const baseName = (bid: string | null) => geo.bases.find((b) => b.id === bid)?.name ?? '—';
  const roadName = (sid: string) => geo.roads.find((r) => r.id === sid)?.name ?? 'Unnamed road';

  async function act(key: string, fn: () => Promise<Situation>, ok: string) {
    setBusy(key);
    try { setSituation(await fn()); notify('ok', ok); } catch (e) { notify('error', (e as Error).message); } finally { setBusy(null); }
  }

  return (
    <div className="p-3 space-y-4">
      <header className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold leading-tight">{s.name}{s.name_mr ? <span className="text-ink-3 font-normal"> · {s.name_mr}</span> : null}</h2>
          <p className="text-xs text-ink-3 mt-0.5 capitalize">
            {s.kind} · population {s.population != null ? `${s.population.toLocaleString('en-IN')} (${s.population_source})` : 'unknown'}
          </p>
        </div>
        <button onClick={() => select(null)} className="text-ink-3 hover:text-ink p-1" aria-label="Close settlement details"><X className="w-4 h-4" /></button>
      </header>

      {/* Warning, risk and confidence */}
      <section className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <LevelBadge level={w.level} size="lg" />
          {w.version > 0 && <span className="text-xs text-ink-3">Version {w.version}</span>}
          {w.initial_level !== w.level && <Tag title="Level from rainfall, terrain and river data only, before ground reports and the false-alert check">Environment only: {w.initial_level}</Tag>}
          {w.downgrade_pending_since && <Tag tone="info" title="A downgrade needs 3 hours of sustained improvement">Improving since {istTime(w.downgrade_pending_since)}</Tag>}
        </div>
        {w.reason_for_change && <p className="text-xs text-ink-2">Last change: {w.reason_for_change}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Meter label="Flood risk" value={w.risk} tone="risk" />
          <Meter label="Confidence" value={w.confidence.value * 100} tone="confidence" />
        </div>
        <p className="text-[11px] text-ink-3">
          Risk = how severe the expected impact is. Confidence = how strong the evidence is:
          independence {pctOf(w.confidence.independence)}, freshness {pctOf(w.confidence.freshness)}, consistency {pctOf(w.confidence.consistency)}, coverage {pctOf(w.confidence.coverage)}, location {pctOf(w.confidence.location)}.
        </p>
      </section>

      {(w.verification_requested || w.false_alert_notes.length > 0) && (
        <section className={cx('rounded-md border p-2.5 text-xs space-y-1', w.verification_requested ? 'border-synthetic/60 bg-synthetic/10' : 'border-line bg-panel-2')}>
          <p className="font-semibold flex items-center gap-1.5">{w.verification_requested ? <><CircleAlert className="w-3.5 h-3.5" aria-hidden />Verification requested</> : 'False-alert check'}</p>
          {w.false_alert_notes.map((n, i) => <p key={i} className="text-ink-2">{n}</p>)}
        </section>
      )}

      <section>
        <SectionTitle>Why this alert?</SectionTitle>
        <ul className="space-y-1.5">
          {w.evidence.map((e, i) => (
            <li key={i} className="flex gap-2 text-sm">
              {e.supports ? <Check className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" aria-label="supports flooding" /> : <CircleX className="w-4 h-4 text-ink-3 shrink-0 mt-0.5" aria-label="does not support flooding" />}
              <div className="min-w-0">
                <p>
                  {e.label}: <b className="tabular-nums">{e.value ?? '—'}{e.unit ? ` ${e.unit}` : ''}</b>
                  {e.threshold != null && <span className="text-ink-3"> (threshold {e.threshold}{e.unit ? ` ${e.unit}` : ''})</span>}
                </p>
                <p className="text-[11px] text-ink-3 flex flex-wrap gap-x-2">
                  <span>{e.source}</span>
                  <Tag tone={e.mode === 'live' ? 'ok' : e.mode === 'replay' ? 'info' : e.mode === 'synthetic_scenario' ? 'synthetic' : 'neutral'}>{MODE_LABEL[e.mode]}</Tag>
                  {e.observed_at && <span>observed {istTime(e.observed_at)}</span>}
                  <span className={cx(e.stale && 'text-amber-300 font-semibold')}>{e.mode === 'static' ? 'static dataset' : e.stale ? '⚠ DATA STALE' : age(e.age_min)}</span>
                </p>
                {e.threshold_source && <p className="text-[11px] text-ink-3 italic">{e.threshold_source}</p>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {w.data_gaps.length > 0 && (
        <section>
          <SectionTitle>Known data gaps</SectionTitle>
          <ul className="text-xs text-amber-200/90 space-y-0.5 list-disc pl-4">{w.data_gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
        </section>
      )}

      {(w.would_increase.length > 0 || w.would_decrease.length > 0) && (
        <section className="grid grid-cols-2 gap-3 text-xs">
          <div><SectionTitle>Would raise the warning</SectionTitle><ul className="list-disc pl-4 text-ink-2 space-y-0.5">{w.would_increase.map((x) => <li key={x}>{x}</li>)}</ul></div>
          <div><SectionTitle>Would lower it</SectionTitle><ul className="list-disc pl-4 text-ink-2 space-y-0.5">{w.would_decrease.map((x) => <li key={x}>{x}</li>)}</ul></div>
        </section>
      )}

      {/* Access */}
      <section>
        <SectionTitle>Road access</SectionTitle>
        <p className={cx('text-sm', ACCESS_STYLE[a?.status ?? 'UNKNOWN'].cls)}>{ACCESS_STYLE[a?.status ?? 'UNKNOWN'].label}</p>
        {a?.route && (
          <p className="text-xs text-ink-2 mt-1 flex items-center gap-1.5"><Route className="w-3.5 h-3.5" aria-hidden />
            From {baseName(a.base_id)}: {Math.round(a.route.duration_s / 60)} min, {(a.route.distance_m / 1000).toFixed(1)} km by road
            {a.eta_delta_min ? ` (${a.eta_delta_min > 0 ? '+' : ''}${a.eta_delta_min} min vs normal)` : ''}
          </p>
        )}
        {a?.note && <p className="text-xs text-ink-2 mt-1">{a.note}</p>}
        {a && a.blocked_on_baseline.length > 0 && <p className="text-xs text-red-300 mt-1">Usual route blocked at: {[...new Set(a.blocked_on_baseline.map(roadName))].join(', ')}</p>}
      </section>
      {staff && <RoadCloser settlement={s} />}

      {/* Priority */}
      <section>
        <SectionTitle>Response priority</SectionTitle>
        <p className="text-sm"><span className={BAND_STYLE[p.band]}>{p.band}</span> · score {p.score} · rank #{p.rank}{p.previous_rank != null && p.previous_rank !== p.rank ? <span className="text-ink-3"> (was #{p.previous_rank})</span> : null}</p>
        {p.changes.length > 0 && (
          <div className="mt-1.5 rounded border border-line bg-panel-2 p-2">
            <p className="text-[11px] uppercase tracking-wider text-ink-3 mb-0.5">Why priority changed</p>
            <ul className="text-xs space-y-0.5">{p.changes.map((c) => <li key={c}>{c}</li>)}</ul>
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-[11px]">
          {Object.entries(p.components).map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="text-ink-3 w-28 shrink-0">{COMPONENT_LABEL[k]}</span>
              <span className="flex-1 h-1 bg-panel-2 rounded"><span className="block h-full bg-accent rounded" style={{ width: `${v * 100}%` }} /></span>
            </div>
          ))}
        </div>
        {p.unknowns.length > 0 && <p className="text-[11px] text-ink-3 mt-1">Unknown (neutral value used, not estimated): {p.unknowns.join(', ')}</p>}
      </section>

      {/* Recommendations */}
      {(recs.length > 0 || assignments.length > 0) && (
        <section>
          <SectionTitle>Response</SectionTitle>
          <div className="space-y-2">
            {recs.map((r) => <RecommendationCard key={r.id} r={r} unit={unitName(r.unit_id)} staff={staff} busy={busy} onAct={act} />)}
            {assignments.map((x) => (
              <div key={x.id} className="rounded-md border border-cyan-700/60 bg-cyan-900/10 p-2 text-xs">
                <p className="font-medium">{unitName(x.unit_id)} — {x.status.replace('_', ' ').toUpperCase()}</p>
                <p className="text-ink-2">ETA {x.eta_min} min · approved by {x.approved_by} at {istTime(x.approved_at)}</p>
                {x.staging_note && <p className="text-ink-3">{x.staging_note}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Reports */}
      <section>
        <SectionTitle>Ground reports ({reports.length})</SectionTitle>
        {reports.length === 0 && <p className="text-xs text-ink-3">No ground reports near this settlement.</p>}
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.id} className="rounded-md border border-line bg-panel-2/60 p-2 text-xs">
              <p className="text-sm">{r.text}</p>
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                <Tag tone={r.verification === 'verified' ? 'ok' : r.verification === 'corroborated' ? 'warn' : r.verification === 'disputed' ? 'neutral' : 'neutral'}>{r.verification}</Tag>
                <Tag tone={r.mode === 'synthetic_scenario' ? 'synthetic' : r.mode === 'live' ? 'ok' : 'info'}>{MODE_LABEL[r.mode]}</Tag>
                <span className="text-ink-3 flex items-center gap-1"><Clock className="w-3 h-3" aria-hidden />{istDateTime(r.received_at)}</span>
                <span className="text-ink-3">extracted by {r.evidence.extractor}{r.evidence.extractor_confidence_hint != null ? ` (hint ${Math.round(r.evidence.extractor_confidence_hint * 100)}%)` : ''}</span>
              </div>
              <p className="text-ink-3 mt-1">Evidence: {r.evidence.kinds.join(', ') || 'none recognised'}{r.evidence.people_trapped ? ` · trapped: ${r.evidence.people_trapped === -1 ? 'yes' : r.evidence.people_trapped}` : ''}{r.evidence.vulnerable_present ? ' · vulnerable people' : ''}</p>
              {staff && r.verification !== 'verified' && r.verification !== 'disputed' && (
                <div className="flex gap-1.5 mt-1.5">
                  <Button size="sm" variant="success" disabled={!!busy} onClick={() => act(`v${r.id}`, () => api(`/api/reports/${r.id}/verify`, { body: { decision: 'verified' } }), 'Report verified')}><ShieldCheck className="w-3.5 h-3.5" />Verify</Button>
                  <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => act(`d${r.id}`, () => api(`/api/reports/${r.id}/verify`, { body: { decision: 'disputed' } }), 'Report marked disputed')}><ShieldX className="w-3.5 h-3.5" />Dispute</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <VersionHistory id={id} version={w.version} />
    </div>
  );
}

const pctOf = (x: number) => `${Math.round(x * 100)}%`;

export function RecommendationCard({ r, unit, staff, busy, onAct, settlementName }: {
  r: Recommendation; unit: string; staff: boolean; busy: string | null; settlementName?: string;
  onAct: (key: string, fn: () => Promise<Situation>, ok: string) => Promise<void>;
}) {
  const KIND: Record<Recommendation['kind'], string> = { new: 'New assignment', reroute: 'Reroute (road closed)', replacement: 'Replacement', reassign: 'Reassignment' };
  return (
    <div className={cx('rounded-md border p-2 text-xs', r.kind === 'reroute' || r.kind === 'replacement' ? 'border-warning/60 bg-warning/5' : 'border-synthetic/50 bg-synthetic/5')}>
      <div className="flex items-center gap-2">
        <p className="font-medium flex-1">{unit}{settlementName ? ` → ${settlementName}` : ''}</p>
        <Tag tone={r.kind === 'new' ? 'synthetic' : 'warn'}>{KIND[r.kind]}</Tag>
      </div>
      <ul className="text-ink-2 mt-1 space-y-0.5">{r.reasons.map((x) => <li key={x}>• {x}</li>)}</ul>
      {r.staging_note && <p className="text-amber-200/90 mt-1 flex gap-1"><TriangleAlert className="w-3.5 h-3.5 shrink-0" aria-hidden />{r.staging_note}</p>}
      <p className="text-ink-3 mt-1">Awaiting coordinator approval — nothing is dispatched automatically.</p>
      {staff && (
        <div className="flex gap-1.5 mt-1.5">
          <Button size="sm" variant="primary" disabled={!!busy} onClick={() => onAct(`a${r.id}`, () => api(`/api/recommendations/${encodeURIComponent(r.id)}/approve`, { method: 'POST' }), `Approved: ${unit}`)}>Approve</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => onAct(`r${r.id}`, () => api(`/api/recommendations/${encodeURIComponent(r.id)}/reject`, { method: 'POST' }), 'Recommendation rejected')}>Reject</Button>
        </div>
      )}
    </div>
  );
}

function VersionHistory({ id, version }: { id: string; version: number }) {
  const [rows, setRows] = useState<{ version: number; level: string; risk: number; confidence: number; reason: string | null; as_of: string }[] | null>(null);
  const user = useStore((s) => s.user);
  useEffect(() => {
    if (user?.role === 'field') return;
    let cancelled = false;
    api<typeof rows>(`/api/warnings/${id}/history`).then((r) => { if (!cancelled) setRows(r); }).catch(() => setRows([]));
    return () => { cancelled = true; };
  }, [id, version, user]);
  if (!rows?.length) return null;
  return (
    <section>
      <SectionTitle><span className="flex items-center gap-1"><History className="w-3.5 h-3.5" aria-hidden />Warning version history</span></SectionTitle>
      <ol className="space-y-1.5 border-l border-line-strong pl-3">
        {[...rows].reverse().map((v) => (
          <li key={v.version} className="text-xs">
            <p><b>v{v.version}</b> · {v.level} · risk {v.risk} · confidence {Math.round(v.confidence * 100)}% <span className="text-ink-3">· {istDateTime(v.as_of)}</span></p>
            {v.reason && <p className="text-ink-2">{v.reason}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
