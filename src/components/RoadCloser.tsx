import { useMemo, useState } from 'react';
import type { Settlement, Situation } from '../../shared/types';
import { api } from '../lib/api';
import { useStore } from '../store';
import { Button, SectionTitle } from './ui';

const km = (a: { lat: number; lng: number }, b: [number, number]) => Math.hypot((a.lat - b[0]) * 111, (a.lng - b[1]) * 106.6);

/**
 * Coordinator marks a road segment near a settlement as closed (e.g. confirmed by phone or a field unit).
 * In REPLAY the closure is stored as a synthetic-scenario input; in LIVE it is a live coordinator record.
 */
export function RoadCloser({ settlement }: { settlement: Settlement }) {
  const geo = useStore((s) => s.geo)!;
  const sit = useStore((s) => s.situation)!;
  const setSituation = useStore((s) => s.setSituation);
  const notify = useStore((s) => s.notify);
  const [seg, setSeg] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const options = useMemo(() => {
    const blocked = new Set(sit.roads.filter((r) => r.status === 'BLOCKED').map((r) => r.segment_id));
    const access = sit.access.find((a) => a.settlement_id === settlement.id);
    const onRoute = new Set(access?.route?.segment_ids ?? []);
    return geo.roads
      .map((r) => ({ r, d: Math.min(...r.coords.map((c) => km(settlement, c))) }))
      .filter(({ r, d }) => d <= 3 && !blocked.has(r.id))
      .sort((a, b) => Number(onRoute.has(b.r.id)) - Number(onRoute.has(a.r.id)) || Number(b.r.flood_prone) - Number(a.r.flood_prone) || a.d - b.d)
      .slice(0, 40)
      .map(({ r, d }) => ({ id: r.id, label: `${onRoute.has(r.id) ? '★ on current route · ' : ''}${r.name ?? 'Unnamed'} (${r.road_class}${r.is_bridge ? ', bridge' : ''}${r.flood_prone ? ', flood-prone' : ''}) · ${d.toFixed(1)} km` }));
  }, [geo, sit, settlement]);

  async function submit() {
    setBusy(true);
    try {
      setSituation(await api<Situation>(`/api/roads/${seg}`, { body: { action: 'close', reason } }));
      notify('ok', 'Road marked closed — routes and priorities recalculated');
      setSeg(''); setReason('');
    } catch (e) { notify('error', (e as Error).message); } finally { setBusy(false); }
  }

  return (
    <section className="rounded-md border border-line p-2.5">
      <SectionTitle>Mark a road closed near here</SectionTitle>
      <select value={seg} onChange={(e) => setSeg(e.target.value)} aria-label="Road segment" className="w-full bg-panel-2 border border-line rounded px-2 py-1.5 text-xs">
        <option value="">Choose a road segment…</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (e.g. field unit confirms water over road)" aria-label="Reason"
        className="w-full bg-panel-2 border border-line rounded px-2 py-1.5 text-xs mt-1.5" maxLength={200} />
      <Button size="sm" variant="danger" className="mt-1.5" disabled={!seg || !reason.trim() || busy} onClick={submit}>Close road</Button>
      {sit.mode === 'replay' && <p className="text-[11px] text-ink-3 mt-1">During replay this closure is recorded as a synthetic scenario input.</p>}
    </section>
  );
}
