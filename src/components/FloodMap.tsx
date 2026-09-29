import { useEffect, useMemo } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import { latLngBounds } from 'leaflet';
import type { Settlement } from '../../shared/types';
import { LEVEL_STYLE, ROAD_STYLE } from '../lib/format';
import { useStore, type Layers } from '../store';
import { cx } from './ui';

const RADIUS = { NONE: 3, WATCH: 5, WARNING: 7, SEVERE: 9 } as const;
const REPORT_COLOR = { unverified: '#cbd5e1', corroborated: '#f59e0b', verified: '#22c55e', disputed: '#475569' } as const;

function FitDistrict() {
  const map = useMap();
  const boundary = useStore((s) => s.geo?.boundary);
  useEffect(() => {
    if (!boundary?.length) return;
    map.fitBounds(latLngBounds(boundary.flat()), { padding: [10, 10] });
  }, [boundary, map]);
  return null;
}

function FlyToSelected({ settlement }: { settlement: Settlement | undefined }) {
  const map = useMap();
  useEffect(() => {
    if (settlement) map.flyTo([settlement.lat, settlement.lng], Math.max(map.getZoom(), 12), { duration: 0.6 });
  }, [settlement, map]);
  return null;
}

export function FloodMap() {
  const geo = useStore((s) => s.geo);
  const sit = useStore((s) => s.situation);
  const layers = useStore((s) => s.layers);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);

  const roadById = useMemo(() => new Map((geo?.roads ?? []).map((r) => [r.id, r])), [geo]);
  const warnings = useMemo(() => new Map((sit?.warnings ?? []).map((w) => [w.settlement_id, w])), [sit]);
  const access = useMemo(() => new Map((sit?.access ?? []).map((a) => [a.settlement_id, a])), [sit]);
  const prio = useMemo(() => new Map((sit?.priorities ?? []).map((p) => [p.settlement_id, p])), [sit]);
  const selectedSettlement = geo?.settlements.find((s) => s.id === selected);

  if (!geo) return <div className="h-full grid place-items-center text-ink-3 text-sm">Loading map…</div>;
  const ordered = [...geo.settlements].sort((a, b) => RADIUS[warnings.get(a.id)?.level ?? 'NONE'] - RADIUS[warnings.get(b.id)?.level ?? 'NONE']);

  return (
    <div className="relative h-full">
      <MapContainer center={[16.7, 74.24]} zoom={10} preferCanvas className="h-full w-full map-dark" zoomControl>
        <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' maxZoom={18} />
        <FitDistrict />
        <FlyToSelected settlement={selectedSettlement} />
        {geo.boundary.map((ring, i) => <Polyline key={`b${i}`} positions={ring} pathOptions={{ color: '#94a3b8', weight: 1.5, dashArray: '6 4', opacity: 0.7 }} interactive={false} />)}
        {layers.rivers && geo.rivers.map((r, i) => <Polyline key={`r${i}`} positions={r.coords} pathOptions={{ color: '#3b82f6', weight: 2, opacity: 0.55 }} interactive={false} />)}
        {layers.floodProne && geo.roads.filter((r) => r.flood_prone).map((r) => (
          <Polyline key={`fp${r.id}`} positions={r.coords} pathOptions={{ color: '#fbbf24', weight: 2, opacity: 0.45 }}>
            <Tooltip sticky>{r.name ?? 'Unnamed road'} — flood-prone: {r.flood_prone_reason}</Tooltip>
          </Polyline>
        ))}
        {layers.roads && (sit?.roads ?? []).map((st) => {
          const r = roadById.get(st.segment_id);
          if (!r) return null;
          const blocked = st.status === 'BLOCKED';
          return (
            <Polyline key={`st${st.segment_id}`} positions={r.coords} pathOptions={{ color: ROAD_STYLE[st.status].color, weight: blocked ? 6 : 4, dashArray: blocked ? undefined : '6 5', opacity: 0.95 }}>
              <Tooltip sticky><b>{r.name ?? 'Unnamed road'}</b> — {ROAD_STYLE[st.status].label.toUpperCase()}<br />{st.reason}<br /><span style={{ opacity: 0.7 }}>Source: {st.source}</span></Tooltip>
            </Polyline>
          );
        })}
        {layers.routes && selected && access.get(selected)?.route?.coords.length ? (
          <Polyline positions={access.get(selected)!.route!.coords} pathOptions={{ color: '#38bdf8', weight: 5, opacity: 0.85 }}>
            <Tooltip sticky>Current fastest valid road route from nearest base</Tooltip>
          </Polyline>
        ) : null}
        {layers.routes && (sit?.recommendations ?? []).filter((r) => !selected || r.settlement_id === selected).map((r) => (
          <Polyline key={`rec${r.id}`} positions={r.route.coords} pathOptions={{ color: '#c084fc', weight: 3, dashArray: '2 6', opacity: 0.9 }}>
            <Tooltip sticky>Proposed ({r.kind}) — ETA {r.eta_min} min · awaiting approval</Tooltip>
          </Polyline>
        ))}
        {layers.routes && (sit?.assignments ?? []).filter((a) => ['assigned', 'en_route'].includes(a.status)).map((a) => (
          <Polyline key={`as${a.id}`} positions={a.route.coords} pathOptions={{ color: '#22d3ee', weight: 4, opacity: 0.9 }}>
            <Tooltip sticky>Approved route — {a.status.replace('_', ' ')} · ETA {a.eta_min} min</Tooltip>
          </Polyline>
        ))}
        {layers.units && geo.bases.map((b) => {
          const units = (sit?.units ?? []).filter((u) => u.base_id === b.id);
          return (
            <CircleMarker key={b.id} center={[b.lat, b.lng]} radius={5} pathOptions={{ color: '#14b8a6', fillColor: '#0f766e', fillOpacity: 0.9, weight: 2 }}>
              <Tooltip>{b.name}<br />{units.map((u) => `${u.name} (${u.status})`).join(', ')}<br /><i>Demo units (synthetic)</i></Tooltip>
            </CircleMarker>
          );
        })}
        {layers.settlements && ordered.map((s) => {
          const w = warnings.get(s.id);
          const lvl = w?.level ?? 'NONE';
          const a = access.get(s.id);
          const cut = a?.status === 'CUT_OFF';
          const isSel = s.id === selected;
          const rank = prio.get(s.id)?.rank ?? 999;
          return (
            <CircleMarker
              key={s.id} center={[s.lat, s.lng]} radius={RADIUS[lvl] + (isSel ? 3 : 0)}
              pathOptions={{ color: isSel ? '#ffffff' : cut ? '#fecaca' : LEVEL_STYLE[lvl].color, weight: isSel || cut ? 3 : 1, dashArray: cut ? '3 3' : undefined, fillColor: LEVEL_STYLE[lvl].color, fillOpacity: lvl === 'NONE' ? 0.35 : 0.8 }}
              eventHandlers={{ click: () => select(s.id) }}
            >
              <Tooltip permanent={lvl !== 'NONE' && rank <= 12} direction="right" offset={[8, 0]} className="settlement-label">
                {s.name}{lvl !== 'NONE' ? ` · ${lvl}` : ''}{cut ? ' · CUT OFF' : ''}
              </Tooltip>
            </CircleMarker>
          );
        })}
        {layers.reports && (sit?.reports ?? []).map((r) => (
          <CircleMarker key={r.id} center={[r.lat, r.lng]} radius={4} pathOptions={{ color: r.mode === 'synthetic_scenario' ? '#a855f7' : '#e2e8f0', weight: 1.5, fillColor: REPORT_COLOR[r.verification], fillOpacity: 1 }}>
            <Tooltip>{r.verification.toUpperCase()} report{r.mode === 'synthetic_scenario' ? ' (synthetic scenario)' : ''}<br />{r.text.slice(0, 90)}</Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
      <LayerControl />
      <Legend />
    </div>
  );
}

const LAYER_LABELS: [keyof Layers, string][] = [
  ['settlements', 'Settlements'], ['roads', 'Road status'], ['routes', 'Routes'], ['reports', 'Ground reports'],
  ['units', 'Response units'], ['rivers', 'Rivers'], ['floodProne', 'Flood-prone roads'],
];

function LayerControl() {
  const layers = useStore((s) => s.layers);
  const toggle = useStore((s) => s.toggleLayer);
  return (
    <fieldset className="absolute top-2 right-2 z-[500] bg-panel/95 border border-line rounded-md px-2.5 py-2 text-xs space-y-1">
      <legend className="sr-only">Map layers</legend>
      {LAYER_LABELS.map(([k, label]) => (
        <label key={k} className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={layers[k]} onChange={() => toggle(k)} className="accent-accent" /> {label}
        </label>
      ))}
    </fieldset>
  );
}

function Legend() {
  const item = (color: string, label: string, dashed = false) => (
    <span className="flex items-center gap-1.5"><span className={cx('inline-block w-4 h-0.5', dashed && 'border-t-2 border-dashed h-0')} style={dashed ? { borderColor: color } : { background: color, height: 3 }} />{label}</span>
  );
  return (
    <div className="absolute bottom-2 left-2 z-[500] bg-panel/95 border border-line rounded-md px-2.5 py-2 text-[11px] text-ink-2 grid grid-cols-2 gap-x-4 gap-y-1">
      {(['SEVERE', 'WARNING', 'WATCH', 'NONE'] as const).map((l) => (
        <span key={l} className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: LEVEL_STYLE[l].color }} />{LEVEL_STYLE[l].label}</span>
      ))}
      {item('#ef4444', 'Road blocked')}
      {item('#f59e0b', 'Road at risk', true)}
      {item('#38bdf8', 'Valid route')}
      {item('#c084fc', 'Proposed route', true)}
      <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-dashed border-red-200" />Cut off</span>
      <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-purple-400 bg-slate-300" />Synthetic report</span>
    </div>
  );
}
