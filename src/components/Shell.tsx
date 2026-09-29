import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { LogOut, Waves } from 'lucide-react';
import type { Situation } from '../../shared/types';
import { api } from '../lib/api';
import { disconnect, onLink, type LinkState } from '../lib/realtime';
import { useStore } from '../store';
import { ModeBanner } from './ModeBanner';
import { cx } from './ui';

export function Shell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const user = useStore((s) => s.user);
  const sit = useStore((s) => s.situation);
  const system = useStore((s) => s.system);
  const toast = useStore((s) => s.toast);
  const [link, setLink] = useState<LinkState>('connecting');
  useEffect(() => onLink(setLink), []);
  const nav = useNavigate();
  const staff = user?.role === 'admin' || user?.role === 'coordinator';

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    disconnect();
    useStore.getState().setUser(null);
    nav('/login');
  }

  return (
    <div className="h-full flex flex-col">
      <header className="border-b border-line bg-panel px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Waves className="w-5 h-5 text-accent" aria-hidden />
          <div className="leading-tight">
            <p className="font-semibold tracking-wide">FLOOD INTELLIGENCE</p>
            <p className="text-[11px] text-ink-3">Study area: Kolhapur District, Maharashtra · Primary hazard: Flood</p>
          </div>
        </div>
        <nav className="flex items-center gap-1 text-sm" aria-label="Main">
          {staff && <Tab to="/">Command Centre</Tab>}
          <Tab to="/report">New report</Tab>
          {(user?.role === 'field' || user?.role === 'admin') && <Tab to="/field">Field unit</Tab>}
          <Tab to="/public" external>Public view</Tab>
        </nav>
        <div className="flex-1" />
        {user?.role === 'admin' && <ModeSwitch />}
        <span className={cx('text-[11px] px-1.5 py-0.5 rounded border', link === 'live' ? 'border-live/50 text-emerald-300' : 'border-warning/50 text-amber-300')}>
          {link === 'live' ? 'Connected' : link === 'connecting' ? 'Connecting…' : 'Offline — reconnecting'}
        </span>
        <span className="text-xs text-ink-2">{user?.name} <span className="text-ink-3">({user?.role})</span></span>
        <button onClick={logout} className="text-ink-3 hover:text-ink" aria-label="Sign out"><LogOut className="w-4 h-4" /></button>
      </header>
      <div className="px-3 py-2 border-b border-line bg-bg"><ModeBanner situation={sit} liveError={system?.live_error} /></div>
      <main className="flex-1 min-h-0">{children}</main>
      {footer}
      {toast && (
        <div role="alert" className={cx('fixed bottom-16 right-4 z-[1000] max-w-sm rounded-md border px-3 py-2 text-sm shadow-lg', toast.kind === 'ok' ? 'bg-emerald-900/90 border-emerald-600 text-emerald-50' : 'bg-red-950/95 border-red-600 text-red-50')}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

function Tab({ to, children, external }: { to: string; children: ReactNode; external?: boolean }) {
  if (external) return <a href={to} target="_blank" rel="noreferrer" className="px-2.5 py-1 rounded text-ink-2 hover:text-ink">{children}</a>;
  return <NavLink to={to} end className={({ isActive }) => cx('px-2.5 py-1 rounded', isActive ? 'bg-panel-2 text-ink' : 'text-ink-2 hover:text-ink')}>{children}</NavLink>;
}

function ModeSwitch() {
  const sit = useStore((s) => s.situation);
  const setSituation = useStore((s) => s.setSituation);
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState(false);
  async function change(mode: 'live' | 'replay') {
    if (mode === sit?.mode) return;
    if (!window.confirm(`Switch the whole system to ${mode.toUpperCase()} mode? All views will change.`)) return;
    setBusy(true);
    try { setSituation(await api<Situation>('/api/mode', { body: { mode } })); notify('ok', `Mode: ${mode.toUpperCase()}`); }
    catch (e) { notify('error', (e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="flex items-center rounded border border-line text-xs overflow-hidden" role="group" aria-label="System mode">
      {(['replay', 'live'] as const).map((m) => (
        <button key={m} disabled={busy} onClick={() => change(m)} aria-pressed={sit?.mode === m}
          className={cx('px-2 py-1 font-semibold', sit?.mode === m ? (m === 'live' ? 'bg-live text-black' : 'bg-replay text-white') : 'text-ink-2 hover:text-ink')}>
          {m.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
