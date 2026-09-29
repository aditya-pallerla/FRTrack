/** Typed reads/writes. Every read takes the data modes it may return (live view ⇒ ['live'] only). */
import type {
  Assignment, DataMode, GroundReport, RainObservation, ReportEvidence, RoadEvent, SettlementWarning, SystemMode, Verification,
} from '../../../shared/types.js';
import type { Db } from './db.js';

export const MODES_FOR: Record<SystemMode, DataMode[]> = { live: ['live'], replay: ['replay', 'synthetic_scenario'] };

/** Mode for rows created by people while the system is in a given mode. */
export const inputModeFor = (m: SystemMode): DataMode => (m === 'live' ? 'live' : 'synthetic_scenario');

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export class Repo {
  constructor(readonly db: Db) {}

  // ── System state ──
  async getState<T>(key: string, fallback: T): Promise<T> {
    const [row] = await this.db.query<{ value: T }>('SELECT value FROM system_state WHERE key = $1', [key]);
    return row ? row.value : fallback;
  }
  async setState(key: string, value: unknown) {
    await this.db.query(`INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
  }

  // ── Reports ──
  async insertReport(r: GroundReport, meta: { location_method: string; extraction: Record<string, unknown> }) {
    await this.db.query(`INSERT INTO reports (id, mode, received_at, text, lat, lng, location_confidence, location_method, reporter_ref, evidence, extraction)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [r.id, r.mode, r.received_at, r.text, r.lat, r.lng, r.location_confidence, meta.location_method, r.reporter_ref, JSON.stringify(r.evidence), JSON.stringify(meta.extraction)]);
  }
  async listReports(modes: DataMode[]): Promise<GroundReport[]> {
    const rows = await this.db.query<{ id: string; mode: DataMode; received_at: unknown; text: string; lat: number; lng: number; location_confidence: number; reporter_ref: string; evidence: ReportEvidence }>(
      'SELECT * FROM reports WHERE mode = ANY($1) ORDER BY received_at', [modes]);
    return rows.map((r) => ({
      id: r.id, text: r.text, received_at: iso(r.received_at), lat: r.lat, lng: r.lng, location_confidence: r.location_confidence,
      reporter_ref: r.reporter_ref, evidence: r.evidence, verification: 'unverified' as Verification, mode: r.mode,
    }));
  }

  // ── Verification decisions ──
  async decide(reportId: string, mode: DataMode, decision: 'verified' | 'disputed', by: string, note: string | null) {
    await this.db.query(`INSERT INTO report_decisions (report_id, mode, decision, decided_by, note) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (report_id) DO UPDATE SET decision = EXCLUDED.decision, decided_by = EXCLUDED.decided_by, note = EXCLUDED.note, decided_at = now()`,
    [reportId, mode, decision, by, note]);
  }
  async listDecisions(modes: DataMode[]) {
    const rows = await this.db.query<{ report_id: string; decision: 'verified' | 'disputed' }>('SELECT report_id, decision FROM report_decisions WHERE mode = ANY($1)', [modes]);
    return new Map(rows.map((r) => [r.report_id, r.decision]));
  }

  // ── Road events ──
  async insertRoadEvent(e: RoadEvent, by: string | null) {
    await this.db.query('INSERT INTO road_events (id, mode, segment_id, action, at, reason, origin, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [e.id, e.mode, e.segment_id, e.action, e.at, e.reason, e.origin, e.source, by]);
  }
  async listRoadEvents(modes: DataMode[]): Promise<RoadEvent[]> {
    const rows = await this.db.query<RoadEvent & { at: unknown }>('SELECT id, mode, segment_id, action, at, reason, origin, source FROM road_events WHERE mode = ANY($1) ORDER BY at', [modes]);
    return rows.map((r) => ({ ...r, at: iso(r.at) }));
  }

  // ── Live rainfall ──
  async upsertRain(obs: RainObservation[]) {
    for (const o of obs) {
      if (o.mode !== 'live') throw new Error('Only live observations are stored; replay rainfall is read from the bundled files');
      await this.db.query(`INSERT INTO rain_observations (cell_id, observed_at, mode, lat, lng, interval_min, rainfall_mm, source)
        VALUES ($1,$2,'live',$3,$4,$5,$6,$7) ON CONFLICT (cell_id, observed_at, mode) DO UPDATE SET rainfall_mm = EXCLUDED.rainfall_mm, ingested_at = now()`,
      [o.cell_id, o.observed_at, o.lat, o.lng, o.interval_min, o.rainfall_mm, o.source]);
    }
  }
  async listRain(modes: DataMode[], since: string): Promise<RainObservation[]> {
    const rows = await this.db.query<RainObservation & { observed_at: unknown }>(
      'SELECT cell_id, observed_at, mode, lat, lng, interval_min, rainfall_mm, source FROM rain_observations WHERE mode = ANY($1) AND observed_at >= $2 ORDER BY observed_at',
      [modes, since]);
    return rows.map((r) => ({ ...r, observed_at: iso(r.observed_at) }));
  }

  // ── Assignments and rejections ──
  async insertAssignment(a: Assignment, mode: DataMode, recommendationId: string) {
    await this.db.query(`INSERT INTO assignments (id, mode, unit_id, settlement_id, status, route, eta_min, staging_note, recommendation_id, approved_by, approved_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [a.id, mode, a.unit_id, a.settlement_id, a.status, JSON.stringify(a.route), a.eta_min, a.staging_note, recommendationId, a.approved_by, a.approved_at, a.updated_at]);
  }
  async updateAssignment(id: string, patch: Partial<Pick<Assignment, 'status' | 'route' | 'eta_min' | 'staging_note'>>, at: string) {
    const [row] = await this.db.query<{ id: string }>(`UPDATE assignments SET status = COALESCE($2, status), route = COALESCE($3, route),
      eta_min = COALESCE($4, eta_min), staging_note = COALESCE($5, staging_note), updated_at = $6 WHERE id = $1 RETURNING id`,
    [id, patch.status ?? null, patch.route ? JSON.stringify(patch.route) : null, patch.eta_min ?? null, patch.staging_note ?? null, at]);
    return !!row;
  }
  async listAssignments(modes: DataMode[]): Promise<Assignment[]> {
    const rows = await this.db.query<Assignment & { approved_at: unknown; updated_at: unknown }>(
      'SELECT id, unit_id, settlement_id, status, route, eta_min, staging_note, approved_by, approved_at, updated_at FROM assignments WHERE mode = ANY($1) ORDER BY approved_at', [modes]);
    return rows.map((r) => ({ ...r, approved_at: iso(r.approved_at), updated_at: iso(r.updated_at) }));
  }
  async reject(mode: DataMode, unitId: string, settlementId: string, by: string) {
    await this.db.query('INSERT INTO rejections (mode, unit_id, settlement_id, rejected_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [mode, unitId, settlementId, by]);
  }
  async listRejections(modes: DataMode[]) {
    const rows = await this.db.query<{ unit_id: string; settlement_id: string }>('SELECT unit_id, settlement_id FROM rejections WHERE mode = ANY($1)', [modes]);
    return new Set(rows.map((r) => `${r.unit_id}|${r.settlement_id}`));
  }

  // ── Warning history ──
  async recordWarningVersion(mode: DataMode, w: SettlementWarning) {
    await this.db.query(`INSERT INTO warning_versions (mode, settlement_id, version, level, risk, confidence, reason, as_of, snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (mode, settlement_id, version) DO NOTHING`,
    [mode, w.settlement_id, w.version, w.level, w.risk, w.confidence.value, w.reason_for_change, w.as_of, JSON.stringify(w)]);
  }
  async warningHistory(modes: DataMode[], settlementId: string) {
    return this.db.query<{ version: number; level: string; risk: number; confidence: number; reason: string | null; as_of: unknown }>(
      'SELECT version, level, risk, confidence, reason, as_of FROM warning_versions WHERE mode = ANY($1) AND settlement_id = $2 ORDER BY version',
      [modes, settlementId]).then((rows) => rows.map((r) => ({ ...r, as_of: iso(r.as_of) })));
  }

  // ── Audit ──
  async audit(mode: DataMode | SystemMode, actor: string, action: string, details: Record<string, unknown> = {}) {
    await this.db.query('INSERT INTO audit_log (mode, actor, action, details) VALUES ($1,$2,$3,$4)', [mode, actor, action, JSON.stringify(details)]);
  }
  async listAudit(modes: string[], limit = 200) {
    const rows = await this.db.query<{ id: number; at: unknown; mode: string; actor: string; action: string; details: Record<string, unknown> }>(
      'SELECT * FROM audit_log WHERE mode = ANY($1) ORDER BY id DESC LIMIT $2', [modes, limit]);
    return rows.map((r) => ({ ...r, at: iso(r.at) }));
  }

  /** Starts a fresh replay run: removes the previous run's replay/scenario inputs and decisions (audit is kept). */
  async clearReplayRun() {
    const modes = MODES_FOR.replay;
    await this.db.transaction(async (tx) => {
      for (const t of ['reports', 'report_decisions', 'road_events', 'assignments', 'rejections', 'warning_versions']) {
        await tx.query(`DELETE FROM ${t} WHERE mode = ANY($1)`, [modes]);
      }
    });
  }
}
