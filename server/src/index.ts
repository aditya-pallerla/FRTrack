/**
 * HTTP API + Socket.IO. Staff routes need a signed session cookie (roles enforced server-side);
 * the public routes return only public-safe information.
 */
import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import type { Situation } from '../../shared/types.js';
import { COOKIE, ensureUsers, issueToken, login, readCookie, readToken, requireRole } from './auth.js';
import { hasGeography, loadGeography } from './data/geography.js';
import { publicStatus } from './publicView.js';
import { FloodService, HttpError } from './service.js';
import { openDb } from './store/db.js';
import { Repo } from './store/repo.js';

const PROD = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT ?? 3001);

if (!hasGeography()) {
  console.error('\nThe Kolhapur dataset has not been built yet. Run:  npm run data:all\n');
  process.exit(1);
}

const geo = loadGeography();
const repo = new Repo(await openDb());
const firstFieldUnit = geo.units.find((u) => u.type === 'rescue_team')?.id ?? null;
await ensureUsers(repo, firstFieldUnit);
const svc = await FloodService.create(repo, geo);

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.use(express.json({ limit: '100kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
const staff = requireRole('admin', 'coordinator');
const anyUser = requireRole();

// ── Auth ──
app.post('/api/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string') { res.status(400).json({ error: 'bad_request' }); return; }
  const u = await login(repo, username, password, req.ip ?? 'unknown');
  if (u === 'locked') { res.status(429).json({ error: 'locked', message: 'Too many attempts. Try again in 15 minutes.' }); return; }
  if (!u) { res.status(401).json({ error: 'invalid', message: 'Wrong username or password' }); return; }
  res.cookie(COOKIE, issueToken(u), { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 12 * 3600_000 });
  await repo.audit(svc.getMode(), u.username, 'login');
  res.json(u);
}));
app.post('/api/auth/logout', (_req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });
app.get('/api/auth/me', anyUser, (req, res) => { res.json(req.user); });

// ── Static geography (for the map) ──
const geoPayload = {
  settlements: geo.settlements,
  roads: geo.segments.map((s) => ({ id: s.id, name: s.name, road_class: s.road_class, flood_prone: s.flood_prone, flood_prone_reason: s.flood_prone_reason, is_bridge: s.is_bridge, coords: s.coords.map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]) })),
  bases: geo.bases.filter((b) => geo.units.some((u) => u.base_id === b.id)),
  rivers: geo.rivers, boundary: geo.boundary, gauges: geo.gauges, meta: geo.meta,
};
app.get('/api/geography', anyUser, (_req, res) => { res.json(geoPayload); });

// ── Situation and history ──
app.get('/api/situation', anyUser, (_req, res) => { res.json(svc.current()); });
app.get('/api/system', anyUser, (_req, res) => { res.json({ mode: svc.getMode(), events: svc.events(), live_error: svc.getLiveError() }); });
app.get('/api/warnings/:id/history', staff, wrap(async (req, res) => { res.json(await svc.warningHistory(String(req.params.id))); }));
app.get('/api/audit', staff, wrap(async (_req, res) => { res.json(await svc.audit()); }));

// ── Mode and replay ──
app.post('/api/mode', requireRole('admin'), wrap(async (req, res) => {
  const mode = req.body?.mode;
  if (mode !== 'live' && mode !== 'replay') throw new HttpError(400, 'bad_mode', 'mode must be live or replay');
  res.json(await svc.setMode(mode, req.user!.username));
}));
app.post('/api/replay/start', staff, wrap(async (req, res) => {
  const id = String(req.body?.event_id ?? '');
  if (!svc.events().some((e) => e.id === id && e.has_scenario)) throw new HttpError(404, 'unknown_event', 'Unknown replay event');
  res.json(await svc.startReplay(id, req.user!.username));
}));
app.post('/api/replay/control', staff, wrap(async (req, res) => {
  const action = req.body?.action;
  if (!['play', 'pause', 'forward', 'back', 'speed'].includes(action)) throw new HttpError(400, 'bad_action', 'Unknown action');
  res.json(await svc.replayControl(action, Number(req.body?.value)));
}));

// ── Inputs ──
app.post('/api/reports', anyUser, wrap(async (req, res) => { res.json(await svc.submitReport(req.body ?? {}, `staff:${req.user!.username}`)); }));
app.post('/api/reports/:id/verify', staff, wrap(async (req, res) => {
  const decision = req.body?.decision;
  if (decision !== 'verified' && decision !== 'disputed') throw new HttpError(400, 'bad_decision', 'decision must be verified or disputed');
  res.json(await svc.verifyReport(String(req.params.id), decision, req.user!.username, typeof req.body?.note === 'string' ? req.body.note.slice(0, 300) : null));
}));
app.post('/api/roads/:id', staff, wrap(async (req, res) => {
  const action = req.body?.action;
  if (action !== 'close' && action !== 'reopen') throw new HttpError(400, 'bad_action', 'action must be close or reopen');
  res.json(await svc.setRoad(String(req.params.id), action, String(req.body?.reason ?? ''), req.user!.username));
}));

// ── Decisions ──
app.post('/api/recommendations/:id/approve', staff, wrap(async (req, res) => { res.json(await svc.approve(String(req.params.id), req.user!.username)); }));
app.post('/api/recommendations/:id/reject', staff, wrap(async (req, res) => { res.json(await svc.reject(String(req.params.id), req.user!.username)); }));
app.patch('/api/assignments/:id', anyUser, wrap(async (req, res) => {
  const status = req.body?.status;
  if (!['en_route', 'on_scene', 'completed', 'cancelled'].includes(status)) throw new HttpError(400, 'bad_status', 'Unknown status');
  if (req.user!.role === 'field' && status === 'cancelled') throw new HttpError(403, 'forbidden', 'Only a coordinator can cancel');
  res.json(await svc.updateAssignment(String(req.params.id), status, req.user!));
}));

// ── Public (no login) ──
const publicHits = new Map<string, number[]>();
app.get('/api/public/status', (_req, res) => { res.json(publicStatus(svc.current(), geo)); });
app.get('/api/public/settlements', (_req, res) => { res.json(geo.settlements.map((s) => ({ id: s.id, name: s.name, name_mr: s.name_mr }))); });
app.post('/api/public/reports', wrap(async (req, res) => {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const hits = (publicHits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  if (hits.length >= 8) { res.status(429).json({ error: 'rate_limited', message: 'Too many reports from this connection. Please wait a few minutes.' }); return; }
  publicHits.set(ip, [...hits, now]);
  const { report } = await svc.submitReport(req.body ?? {}, `public:${Buffer.from(ip).toString('base64url').slice(0, 12)}`);
  // Public response is deliberately minimal (no scores, no internal state).
  res.json({ id: report.id, received: true, understood: report.evidence.kinds });
}));

// ── Errors ──
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  void _next;
  if (err instanceof HttpError) { res.status(err.status).json({ error: err.code, message: err.message }); return; }
  console.error(err);
  res.status(500).json({ error: 'internal', message: 'Unexpected server error' });
});

// ── Production static files ──
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');
if (PROD && existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => { res.sendFile(join(dist, 'index.html')); });
}

// ── Socket.IO: staff channel (cookie auth) and public channel (public-safe status only) ──
const http = createServer(app);
const io = new Server(http, { serveClient: false });
io.use((socket, next) => {
  const u = readToken(readCookie(socket.handshake.headers.cookie, COOKIE));
  if (!u) { next(new Error('unauthorized')); return; }
  socket.data.user = u;
  next();
});
io.on('connection', (socket) => { const s = svc.current(); if (s) socket.emit('situation', s); });
const pub = io.of('/public');
pub.on('connection', (socket) => { socket.emit('status', publicStatus(svc.current(), geo)); });
svc.onUpdate((s: Situation) => {
  io.emit('situation', s);
  pub.emit('status', publicStatus(s, geo));
});

http.listen(PORT, () => console.log(`[api] listening on http://localhost:${PORT} — mode ${svc.getMode().toUpperCase()}`));
