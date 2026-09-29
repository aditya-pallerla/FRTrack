/** Shared helpers for the one-time data pipeline (run with `npm run data:all`; needs internet). */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const RAW = join(ROOT, 'data', 'raw');
export const BUILT = join(ROOT, 'data', 'kolhapur');

export const USER_AGENT = 'KolhapurFloodResponse/0.1 (HackMatrix 5.0 prototype; contact via project repository)';

export function saveJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 1));
  console.log(`  wrote ${path.replace(ROOT, '.')}`);
}

export function loadJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`Missing ${path.replace(ROOT, '.')} — run the earlier data step first.`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with retries and back-off; throws with the response body on persistent failure. */
export async function fetchJson<T>(url: string, init: RequestInit = {}, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(300_000) });
      if (res.ok) return (await res.json()) as T;
      const body = await res.text();
      last = new Error(`HTTP ${res.status} from ${new URL(url).host}: ${body.slice(0, 300)}`);
      if (res.status !== 429 && res.status < 500) break;
      if (res.status === 429) { console.warn('\n  rate limited — waiting 65 s'); await sleep(65_000); continue; }
    } catch (err) {
      last = err;
    }
    await sleep(2000 * 2 ** i);
  }
  throw last;
}

export interface RawMeta {
  fetched_at: string;
  source: string;
  url: string;
  licence: string;
  query?: string;
  params?: Record<string, unknown>;
}
