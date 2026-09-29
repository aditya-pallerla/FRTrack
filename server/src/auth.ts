/**
 * Authentication: scrypt password hashes, HMAC-signed session token in an httpOnly SameSite=strict
 * cookie, three roles. Demo accounts are created on first start; passwords come from the environment
 * (defaults are for local demos only and are printed once at start-up).
 */
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import type { Repo } from './store/repo.js';

export type Role = 'admin' | 'coordinator' | 'field';
export interface User { username: string; name: string; role: Role; unit_id: string | null; hash: string }
export interface SessionUser { username: string; name: string; role: Role; unit_id: string | null }

export const COOKIE = 'kfr_session';
const TTL_MS = 12 * 60 * 60 * 1000;
const SECRET = (() => {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.argv.includes('--production')) throw new Error('SESSION_SECRET (≥32 chars) is required in production');
  // Development: a random secret kept in a local, git-ignored file so a server restart keeps sessions.
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '../data/dev-session-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const fresh = crypto.randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fresh, { mode: 0o600 });
  return fresh;
})();

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function checkPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const a = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sign = (payload: string) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

export function issueToken(u: SessionUser): string {
  const payload = Buffer.from(JSON.stringify({ ...u, exp: Date.now() + TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function readToken(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as SessionUser & { exp: number };
    if (data.exp < Date.now()) return null;
    return { username: data.username, name: data.name, role: data.role, unit_id: data.unit_id };
  } catch { return null; }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export async function ensureUsers(repo: Repo, firstFieldUnit: string | null): Promise<User[]> {
  let users = await repo.getState<User[]>('users', []);
  if (users.length) return users;
  const pw = (env: string, def: string) => process.env[env] || def;
  users = [
    { username: 'admin', name: 'Administrator', role: 'admin', unit_id: null, hash: hashPassword(pw('SEED_ADMIN_PASSWORD', 'Admin@12345')) },
    { username: 'coordinator', name: 'Flood Coordinator', role: 'coordinator', unit_id: null, hash: hashPassword(pw('SEED_COORDINATOR_PASSWORD', 'Coord@12345')) },
    { username: 'field', name: 'Field Unit', role: 'field', unit_id: firstFieldUnit, hash: hashPassword(pw('SEED_FIELD_PASSWORD', 'Field@12345')) },
  ];
  await repo.setState('users', users);
  console.log('[auth] demo accounts created: admin / coordinator / field (see README for default passwords; override with SEED_*_PASSWORD)');
  return users;
}

const failures = new Map<string, { n: number; at: number }>();

export async function login(repo: Repo, username: string, password: string, ip: string): Promise<SessionUser | 'locked' | null> {
  const f = failures.get(ip);
  if (f && f.n >= 10 && Date.now() - f.at < 15 * 60_000) return 'locked';
  const u = (await repo.getState<User[]>('users', [])).find((x) => x.username === username);
  if (!u || !checkPassword(password, u.hash)) {
    failures.set(ip, { n: (f && Date.now() - f.at < 15 * 60_000 ? f.n : 0) + 1, at: Date.now() });
    return null;
  }
  failures.delete(ip);
  return { username: u.username, name: u.name, role: u.role, unit_id: u.unit_id };
}

declare module 'express-serve-static-core' { interface Request { user?: SessionUser } }

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = readToken(readCookie(req.headers.cookie, COOKIE));
    if (!u) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (roles.length && !roles.includes(u.role)) { res.status(403).json({ error: 'forbidden' }); return; }
    req.user = u;
    next();
  };
}
