import { io, type Socket } from 'socket.io-client';
import type { Situation } from '../../shared/types';
import { useStore } from '../store';

let socket: Socket | null = null;
export type LinkState = 'connecting' | 'live' | 'offline';
const linkListeners = new Set<(s: LinkState) => void>();
let link: LinkState = 'connecting';
const setLink = (s: LinkState) => { link = s; linkListeners.forEach((f) => f(s)); };

export function connect() {
  if (socket) return;
  socket = io({ withCredentials: true, transports: ['websocket', 'polling'] });
  socket.on('connect', () => { setLink('live'); void useStore.getState().loadStatic(); });
  socket.on('disconnect', () => setLink('offline'));
  socket.on('connect_error', () => setLink('offline'));
  socket.on('situation', (s: Situation) => useStore.getState().setSituation(s));
}

export function disconnect() { socket?.disconnect(); socket = null; }

export function onLink(fn: (s: LinkState) => void) { linkListeners.add(fn); fn(link); return () => { linkListeners.delete(fn); }; }
