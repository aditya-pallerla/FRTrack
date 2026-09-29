import { useEffect, useState } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from 'react-leaflet';
import { io } from 'socket.io-client';
import { History, Radio, Waves } from 'lucide-react';
import type { WarningLevel } from '../../shared/types';
import { ReportForm } from '../components/ReportForm';
import { LevelBadge, Panel, SectionTitle } from '../components/ui';
import { api } from '../lib/api';
import { LEVEL_STYLE, istDateTime } from '../lib/format';

interface PublicStatus {
  mode: 'live' | 'replay' | null;
  replay: { event_name: string; original_time: string } | null;
  as_of: string | null;
  highest_level: WarningLevel;
  counts: { SEVERE: number; WARNING: number; WATCH: number };
  areas: { settlement_id: string; name: string; name_mr: string | null; level: WarningLevel; lat: number; lng: number; road_access: string }[];
  closed_roads: { name: string; pieces: [number, number][][] }[];
  advice: string[];
  shelter_note: string;
}

/** Citizen view (no login): warning level, affected areas, closed roads, safety advice, report button. */
export function PublicPage() {
  const [st, setSt] = useState<PublicStatus | null>(null);
  useEffect(() => {
    api<PublicStatus>('/api/public/status').then(setSt).catch(() => undefined);
    const socket = io('/public', { transports: ['websocket', 'polling'] });
    socket.on('status', (s: PublicStatus) => setSt(s));
    return () => { socket.disconnect(); };
  }, []);

  // Tolerate an older server payload (e.g. during a dev restart) instead of crashing.
  const counts = st?.counts ?? { SEVERE: 0, WARNING: 0, WATCH: 0 };
  const closed = st?.closed_roads?.filter((r) => Array.isArray(r.pieces)) ?? [];
  return (
    <div className="min-h-full">
      <header className="border-b border-line bg-panel px-4 py-3 flex items-center gap-2">
        <Waves className="w-5 h-5 text-accent" aria-hidden />
        <div><h1 className="font-semibold">Kolhapur flood information</h1><p className="text-xs text-ink-3">Kolhapur District, Maharashtra · Emergency: 112 · District control room: 1077</p></div>
      </header>
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        {st?.mode === 'replay' && (
          <div role="status" className="rounded-md border-2 border-replay bg-replay/15 px-3 py-2 text-sm text-blue-100 flex flex-wrap gap-x-3">
            <span className="font-bold flex items-center gap-1.5"><History className="w-4 h-4" aria-hidden />DEMONSTRATION — HISTORICAL REPLAY</span>
            <span>{st.replay?.event_name}</span>
            <span>Original time: {istDateTime(st.as_of)}</span>
            <span className="font-bold">NOT CURRENT CONDITIONS</span>
          </div>
        )}
        {st?.mode === 'live' && (
          <div role="status" className="rounded-md border-2 border-live bg-live/10 px-3 py-2 text-sm text-emerald-100 flex gap-3"><span className="font-bold flex items-center gap-1.5"><Radio className="w-4 h-4" aria-hidden />LIVE</span><span>Updated {istDateTime(st.as_of)}</span></div>
        )}
        <Panel className="p-4">
          <SectionTitle>Current flood warning</SectionTitle>
          {st ? (
            <>
              <div className="flex items-center gap-3"><LevelBadge level={st.highest_level} size="lg" /><p className="text-sm text-ink-2">{counts.SEVERE + counts.WARNING ? `${counts.SEVERE} severe · ${counts.WARNING} warning` : 'No flood warning in the district'}{counts.WATCH ? ` · ${counts.WATCH} areas on flood watch (stay alert)` : ''}</p></div>
              <ul className="mt-3 space-y-1 text-sm">{st.advice.map((a) => <li key={a}>• {a}</li>)}</ul>
            </>
          ) : <p className="text-sm text-ink-3">Loading…</p>}
        </Panel>
        {st && st.areas.length > 0 && (
          <Panel className="overflow-hidden">
            <div className="h-72">
              <MapContainer center={[16.7, 74.24]} zoom={9} className="h-full w-full map-dark" scrollWheelZoom={false}>
                <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
                {closed.flatMap((r, i) => r.pieces.map((p, k) => <Polyline key={`${i}-${k}`} positions={p} pathOptions={{ color: '#ef4444', weight: 5 }}><Tooltip>{r.name}: closed</Tooltip></Polyline>))}
                {st.areas.map((a) => (
                  <CircleMarker key={a.settlement_id} center={[a.lat, a.lng]} radius={8} pathOptions={{ color: LEVEL_STYLE[a.level].color, fillColor: LEVEL_STYLE[a.level].color, fillOpacity: 0.8 }}>
                    <Tooltip>{a.name}: {a.level} · {a.road_access}</Tooltip>
                  </CircleMarker>
                ))}
              </MapContainer>
            </div>
            <ul className="divide-y divide-line text-sm">
              {st.areas.slice(0, 30).map((a) => (
                <li key={a.settlement_id} className="px-4 py-2 flex items-center gap-2"><LevelBadge level={a.level} /><span className="flex-1">{a.name}{a.name_mr ? ` (${a.name_mr})` : ''}</span><span className="text-xs text-ink-2">{a.road_access}</span></li>
              ))}
            </ul>
          </Panel>
        )}
        {closed.length > 0 && (
          <Panel className="p-4"><SectionTitle>Closed roads</SectionTitle><ul className="text-sm space-y-0.5">{closed.map((r, i) => <li key={i}>• {r.name}</li>)}</ul></Panel>
        )}
        {st && <p className="text-xs text-ink-3">{st.shelter_note}</p>}
        <Panel className="p-4"><SectionTitle>Report flooding</SectionTitle><ReportForm endpoint="/api/public/reports" /></Panel>
      </div>
    </div>
  );
}
