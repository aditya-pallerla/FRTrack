import { useState } from 'react';
import { MapContainer, Polyline, TileLayer, CircleMarker } from 'react-leaflet';
import { Navigation } from 'lucide-react';
import type { Assignment, Situation } from '../../shared/types';
import { Shell } from '../components/Shell';
import { Button, LevelBadge, Panel, SectionTitle } from '../components/ui';
import { api } from '../lib/api';
import { istTime } from '../lib/format';
import { useStore } from '../store';

const NEXT: Partial<Record<Assignment['status'], { to: Assignment['status']; label: string }>> = {
  assigned: { to: 'en_route', label: 'Mark en route' },
  en_route: { to: 'on_scene', label: 'Arrived at settlement' },
  on_scene: { to: 'completed', label: 'Response completed' },
};

export function FieldPage() {
  const user = useStore((s) => s.user)!;
  const sit = useStore((s) => s.situation);
  const geo = useStore((s) => s.geo);
  const setSituation = useStore((s) => s.setSituation);
  const notify = useStore((s) => s.notify);
  const [unitId, setUnitId] = useState<string | null>(user.unit_id);
  const [busy, setBusy] = useState(false);
  const unit = sit?.units.find((u) => u.id === unitId);
  const job = sit?.assignments.find((a) => a.unit_id === unitId && ['assigned', 'en_route', 'on_scene'].includes(a.status));
  const settlement = geo?.settlements.find((s) => s.id === job?.settlement_id);
  const warning = sit?.warnings.find((w) => w.settlement_id === job?.settlement_id);
  const routeBlocked = job?.route.segment_ids.some((id) => sit?.roads.some((r) => r.segment_id === id && r.status === 'BLOCKED'));

  async function advance(to: Assignment['status']) {
    if (!job) return;
    setBusy(true);
    try { setSituation(await api<Situation>(`/api/assignments/${job.id}`, { method: 'PATCH', body: { status: to } })); notify('ok', 'Status updated'); }
    catch (e) { notify('error', (e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Shell>
      <div className="h-full overflow-y-auto p-3">
        <div className="max-w-xl mx-auto space-y-3">
          {user.role === 'admin' && (
            <label className="block text-sm">Acting for unit
              <select value={unitId ?? ''} onChange={(e) => setUnitId(e.target.value)} className="mt-1 w-full bg-panel-2 border border-line rounded px-2 py-2">
                <option value="">Choose a unit…</option>
                {(sit?.units ?? []).map((u) => <option key={u.id} value={u.id}>{u.name} ({u.status})</option>)}
              </select>
            </label>
          )}
          <Panel className="p-3">
            <p className="font-semibold">{unit?.name ?? 'No unit linked'} <span className="text-xs text-ink-3">demo unit (synthetic)</span></p>
            <p className="text-xs text-ink-2 capitalize">{unit?.type.replace('_', ' ')} · {unit?.status.replace('_', ' ')}</p>
          </Panel>
          {!job ? (
            <Panel className="p-4 text-sm text-ink-2">No active assignment. New assignments appear here after a coordinator approves them.</Panel>
          ) : (
            <Panel className="p-3 space-y-3">
              <SectionTitle>Current assignment</SectionTitle>
              <div className="flex items-center gap-2"><h2 className="text-lg font-semibold flex-1">{settlement?.name}</h2>{warning && <LevelBadge level={warning.level} size="lg" />}</div>
              <p className="text-sm">ETA {job.eta_min} min by road · {(job.route.distance_m / 1000).toFixed(1)} km · approved {istTime(job.approved_at)}</p>
              {job.staging_note && <p className="text-sm text-amber-200">{job.staging_note}</p>}
              {routeBlocked && <p role="alert" className="text-sm text-red-300 font-semibold">A road on this route is now BLOCKED. Wait for the coordinator's new route.</p>}
              {job.route.coords.length > 1 && (
                <div className="h-64 rounded overflow-hidden border border-line">
                  <MapContainer bounds={job.route.coords} className="h-full w-full map-dark" scrollWheelZoom={false}>
                    <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
                    <Polyline positions={job.route.coords} pathOptions={{ color: '#22d3ee', weight: 5 }} />
                    {settlement && <CircleMarker center={[settlement.lat, settlement.lng]} radius={8} pathOptions={{ color: '#fff', fillColor: '#ef4444', fillOpacity: 0.9 }} />}
                  </MapContainer>
                </div>
              )}
              {settlement && (
                <a className="inline-flex items-center gap-1.5 text-sm underline" target="_blank" rel="noreferrer"
                  href={`https://www.google.com/maps/dir/?api=1&destination=${settlement.lat},${settlement.lng}`}><Navigation className="w-4 h-4" aria-hidden />Open navigation</a>
              )}
              {NEXT[job.status] && (
                <Button variant="primary" className="w-full min-h-12 text-base" disabled={busy} onClick={() => advance(NEXT[job.status]!.to)}>{NEXT[job.status]!.label}</Button>
              )}
            </Panel>
          )}
        </div>
      </div>
    </Shell>
  );
}
