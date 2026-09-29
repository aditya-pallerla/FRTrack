import { create } from 'zustand';
import type { ResponseBase, RiverGauge, Settlement, Situation, SituationChange } from '../shared/types';
import { api } from './lib/api';

export interface SessionUser { username: string; name: string; role: 'admin' | 'coordinator' | 'field'; unit_id: string | null }

export interface MapRoad { id: string; name: string | null; road_class: string; flood_prone: boolean; flood_prone_reason: string | null; is_bridge: boolean; coords: [number, number][] }
export interface Geography {
  settlements: Settlement[];
  roads: MapRoad[];
  bases: ResponseBase[];
  rivers: { name: string; coords: [number, number][] }[];
  boundary: [number, number][][];
  gauges: RiverGauge[];
  meta: { rules: Record<string, string>; counts: Record<string, number>; built_at: string };
}

export interface Layers {
  settlements: boolean; roads: boolean; floodProne: boolean; reports: boolean; units: boolean; routes: boolean; rivers: boolean;
}

interface State {
  user: SessionUser | null;
  authChecked: boolean;
  geo: Geography | null;
  situation: Situation | null;
  system: { mode: 'live' | 'replay'; events: { id: string; name: string; has_scenario: boolean }[]; live_error: string | null } | null;
  selected: string | null;
  layers: Layers;
  /** Rolling log of changes (newest first) — "what changed and why". */
  log: SituationChange[];
  toast: { kind: 'ok' | 'error'; text: string } | null;
  setUser(u: SessionUser | null): void;
  checkSession(): Promise<void>;
  loadStatic(): Promise<void>;
  setSituation(s: Situation): void;
  select(id: string | null): void;
  toggleLayer(k: keyof Layers): void;
  notify(kind: 'ok' | 'error', text: string): void;
}

export const useStore = create<State>((set, get) => ({
  user: null,
  authChecked: false,
  geo: null,
  situation: null,
  system: null,
  selected: null,
  layers: { settlements: true, roads: true, floodProne: false, reports: true, units: true, routes: true, rivers: true },
  log: [],
  toast: null,
  setUser: (u) => set({ user: u }),
  async checkSession() {
    try { set({ user: await api<SessionUser>('/api/auth/me') }); } catch { set({ user: null }); }
    set({ authChecked: true });
  },
  async loadStatic() {
    const [geo, situation, system] = await Promise.all([
      get().geo ? Promise.resolve(get().geo!) : api<Geography>('/api/geography'),
      api<Situation | null>('/api/situation'),
      api<State['system']>('/api/system'),
    ]);
    set({ geo, system });
    if (situation) get().setSituation(situation);
  },
  setSituation(s) {
    const prev = get().situation;
    // A mode switch clears the change log so replay changes never appear in a live view (and vice versa).
    const modeChanged = prev && (prev.mode !== s.mode || prev.replay?.event_id !== s.replay?.event_id);
    const backwards = prev?.replay && s.replay && s.replay.step < prev.replay.step;
    const log = modeChanged || backwards ? [...s.changes].reverse() : [...[...s.changes].reverse(), ...get().log].slice(0, 200);
    set({ situation: s, log, system: get().system ? { ...get().system!, mode: s.mode } : get().system });
  },
  select: (id) => set({ selected: id }),
  toggleLayer: (k) => set({ layers: { ...get().layers, [k]: !get().layers[k] } }),
  notify(kind, text) {
    set({ toast: { kind, text } });
    setTimeout(() => { if (get().toast?.text === text) set({ toast: null }); }, 5000);
  },
}));
