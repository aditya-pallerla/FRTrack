import { useState } from 'react';
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from 'lucide-react';
import type { Situation } from '../../shared/types';
import { api } from '../lib/api';
import { istDateTime } from '../lib/format';
import { useStore } from '../store';
import { Button, cx } from './ui';

const SPEEDS = [1, 2, 5, 10];

export function ReplayBar() {
  const sit = useStore((s) => s.situation);
  const system = useStore((s) => s.system);
  const user = useStore((s) => s.user);
  const setSituation = useStore((s) => s.setSituation);
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const r = sit?.replay;
  const events = system?.events.filter((e) => e.has_scenario) ?? [];
  const [eventId, setEventId] = useState<string>('');
  const staff = user?.role === 'admin' || user?.role === 'coordinator';
  if (!sit || sit.mode !== 'replay' || !staff) return null;

  async function call(body: object, path = '/api/replay/control') {
    setBusy(true);
    try { setSituation(await api<Situation>(path, { body })); } catch (e) { notify('error', (e as Error).message); } finally { setBusy(false); }
  }
  const chosen = eventId || r?.event_id || events[0]?.id || '';
  const progress = r ? (r.step / Math.max(1, r.total_steps)) * 100 : 0;

  return (
    <div className="border-t-2 border-replay bg-replay/10 px-3 py-2 flex flex-wrap items-center gap-3">
      <span className="text-xs font-bold tracking-wide text-blue-200">REPLAY CONTROLS</span>
      <select value={chosen} onChange={(e) => setEventId(e.target.value)} aria-label="Replay event" className="bg-panel-2 border border-line rounded px-2 py-1 text-xs">
        {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
      <Button size="sm" variant="primary" disabled={busy || !chosen} onClick={() => call({ event_id: chosen }, '/api/replay/start')}><RotateCcw className="w-3.5 h-3.5" />Run Flood Replay</Button>
      <div className="flex items-center gap-1" role="group" aria-label="Playback">
        <Button size="sm" disabled={busy || !r || r.step === 0} onClick={() => call({ action: 'back' })} aria-label="Step back"><SkipBack className="w-3.5 h-3.5" /></Button>
        {r?.playing
          ? <Button size="sm" disabled={busy} onClick={() => call({ action: 'pause' })} aria-label="Pause"><Pause className="w-3.5 h-3.5" />Pause</Button>
          : <Button size="sm" disabled={busy || !r} onClick={() => call({ action: 'play' })} aria-label="Play"><Play className="w-3.5 h-3.5" />Play</Button>}
        <Button size="sm" disabled={busy || !r || r.step >= r.total_steps} onClick={() => call({ action: 'forward' })} aria-label="Step forward"><SkipForward className="w-3.5 h-3.5" /></Button>
      </div>
      <div className="flex items-center gap-1" role="group" aria-label="Speed">
        {SPEEDS.map((s) => (
          <button key={s} disabled={busy || !r} onClick={() => call({ action: 'speed', value: s })} aria-pressed={r?.speed === s}
            className={cx('px-2 py-0.5 text-xs rounded border', r?.speed === s ? 'border-accent bg-accent/20 text-ink' : 'border-line text-ink-2 hover:border-line-strong')}>{s}×</button>
        ))}
      </div>
      {r && (
        <div className="flex-1 min-w-[220px]">
          <div className="flex justify-between text-[11px] text-blue-100/90">
            <span>Step {r.step} / {r.total_steps} (1 step = {r.step_min % 60 === 0 ? `${r.step_min / 60} h` : `${r.step_min} min`} of event time)</span>
            <span className="tabular-nums">Original: {istDateTime(r.original_time)}</span>
          </div>
          <div className="h-1.5 bg-panel-2 rounded mt-1" role="progressbar" aria-valuenow={r.step} aria-valuemin={0} aria-valuemax={r.total_steps} aria-label="Replay progress">
            <div className="h-full bg-replay rounded" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
