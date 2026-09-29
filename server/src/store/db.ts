/**
 * Persistence (embedded PostgreSQL via PGlite; PGLITE_DATA_DIR=memory:// for tests).
 *
 * The engine state is DERIVED from these rows on every evaluation, so the tables hold inputs and
 * decisions (reports, verifications, road events, approvals) plus history for display and audit.
 * Every row carries a data mode, and every read takes the set of modes it may return — which is how
 * replay rows are kept out of the live view (tested in store.test.ts).
 */
import { PGlite } from '@electric-sql/pglite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
      CREATE TABLE system_state (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

      CREATE TABLE reports (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('live', 'replay', 'synthetic_scenario')),
        received_at TIMESTAMPTZ NOT NULL,
        text TEXT NOT NULL,
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        location_confidence DOUBLE PRECISION NOT NULL CHECK (location_confidence BETWEEN 0 AND 1),
        location_method TEXT NOT NULL,
        reporter_ref TEXT NOT NULL,
        evidence JSONB NOT NULL,
        extraction JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX reports_mode_idx ON reports (mode, received_at);

      CREATE TABLE report_decisions (
        report_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('verified', 'disputed')),
        decided_by TEXT NOT NULL,
        note TEXT,
        decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE road_events (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('live', 'replay', 'synthetic_scenario')),
        segment_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('close', 'reopen')),
        at TIMESTAMPTZ NOT NULL,
        reason TEXT NOT NULL,
        origin TEXT NOT NULL,
        source TEXT NOT NULL,
        created_by TEXT
      );
      CREATE INDEX road_events_mode_idx ON road_events (mode, at);

      CREATE TABLE rain_observations (
        cell_id TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('live', 'replay')),
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        interval_min INTEGER NOT NULL,
        rainfall_mm DOUBLE PRECISION,
        source TEXT NOT NULL,
        ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (cell_id, observed_at, mode)
      );

      CREATE TABLE assignments (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        settlement_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('assigned', 'en_route', 'on_scene', 'completed', 'cancelled')),
        route JSONB NOT NULL,
        eta_min INTEGER NOT NULL,
        staging_note TEXT,
        recommendation_id TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        approved_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      -- A unit can hold at most one active assignment per mode, even under concurrent approvals.
      CREATE UNIQUE INDEX one_active_assignment ON assignments (mode, unit_id) WHERE status IN ('assigned', 'en_route', 'on_scene');

      CREATE TABLE rejections (
        mode TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        settlement_id TEXT NOT NULL,
        rejected_by TEXT NOT NULL,
        rejected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (mode, unit_id, settlement_id)
      );

      CREATE TABLE warning_versions (
        mode TEXT NOT NULL,
        settlement_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        level TEXT NOT NULL,
        risk INTEGER NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        reason TEXT,
        as_of TIMESTAMPTZ NOT NULL,
        snapshot JSONB NOT NULL,
        PRIMARY KEY (mode, settlement_id, version)
      );

      -- Audit entries are never deleted, including those from replay runs.
      CREATE TABLE audit_log (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT now(),
        mode TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `,
  },
];

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Pick<Db, 'query'>) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDb(dataDir = process.env.PGLITE_DATA_DIR): Promise<Db> {
  const dir = dataDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../data/pgdata');
  if (!dir.startsWith('memory://')) mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir);
  await pg.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await pg.query<{ id: number }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await pg.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
    });
  }
  return {
    query: async <T>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows,
    exec: async (sql) => { await pg.exec(sql); },
    transaction: (fn) => pg.transaction(async (tx) => fn({ query: async <T>(sql: string, params: unknown[] = []) => (await tx.query<T>(sql, params)).rows })),
    close: () => pg.close(),
  };
}
