/**
 * Application service: owns the system mode, the replay clock, and the latest evaluated situation.
 *
 * Every change (new report, verification, road closure, approval, replay step, live rain poll)
 * triggers a full re-evaluation of the agreed flow; work is serialised so evaluations never overlap.
 * Nothing is dispatched without a coordinator approving a current recommendation.
 */
import crypto from 'node:crypto';
import type {
  Assignment, DataMode, GroundReport, RainObservation, ReplayInfo, Situation, SystemMode, Unit,
} from '../../shared/types.js';
import { buildWorld, evaluate, type Inputs, type World } from './engine/evaluate.js';
import { haversineM } from './engine/geo.js';
import { HOUR, MIN } from './engine/time.js';
import type { Geography } from './data/geography.js';
import { extractEvidence } from './intake/gemini.js';
import { fetchLiveRain, type Cell } from './live/openMeteo.js';
import { listEvents, loadEvent, type ReplayEvent } from './replay/event.js';
import { MODES_FOR, inputModeFor, type Repo } from './store/repo.js';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

interface ReplayState { event: ReplayEvent; step: number; playing: boolean; speed: number; timer: NodeJS.Timeout | null }
type Listener = (s: Situation) => void;

export const REPLAY_SPEEDS = [1, 2, 5, 10];
const STEP_MS_AT_1X = 3000;
const LIVE_POLL_MS = 15 * MIN;

export class FloodService {
  readonly world: World;
  private situation: Situation | null = null;
  private mode: SystemMode = 'replay';
  private replay: ReplayState | null = null;
  private livePoll: NodeJS.Timeout | null = null;
  private liveError: string | null = null;
  private listeners = new Set<Listener>();
  /** Replay results per step, valid while `inputRev` is unchanged (any human input bumps it). */
  private stepCache = new Map<number, { rev: number; situation: Situation }>();
  private inputRev = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cells: Cell[];

  private constructor(readonly repo: Repo, readonly geo: Geography) {
    // Access is measured from bases that actually host a response unit.
    const hosting = new Set(geo.units.map((u) => u.base_id));
    this.world = buildWorld(geo.settlements, geo.segments, geo.bases.filter((b) => hosting.has(b.id)), geo.gauges);
    const cells = new Map<string, Cell>();
    for (const s of geo.settlements) {
      if (!s.rain_cell || cells.has(s.rain_cell)) continue;
      const [lat, lng] = s.rain_cell.slice(1).split('_').map(Number);
      cells.set(s.rain_cell, { id: s.rain_cell, lat, lng });
    }
    this.cells = [...cells.values()];
  }

  static async create(repo: Repo, geo: Geography): Promise<FloodService> {
    const svc = new FloodService(repo, geo);
    svc.mode = await repo.getState<SystemMode>('mode', 'replay');
    const saved = await repo.getState<{ event_id: string; step: number; speed: number } | null>('replay', null);
    if (svc.mode === 'replay') {
      const eventId = saved?.event_id ?? listEvents().find((e) => e.has_scenario)?.id;
      if (eventId) svc.replay = { event: svc.loadEventOrThrow(eventId), step: saved?.step ?? 0, playing: false, speed: saved?.speed ?? 1, timer: null };
    } else {
      svc.startLivePolling();
    }
    await svc.run(() => svc.recomputeReplayTo(svc.replay?.step ?? 0));
    return svc;
  }

  private loadEventOrThrow(id: string) {
    const ev = loadEvent(id, this.geo.settlements, this.geo.segments);
    for (const w of ev.warnings) console.warn(`[replay ${id}] ${w}`);
    return ev;
  }

  onUpdate(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  current(): Situation | null { return this.situation; }
  getMode() { return this.mode; }
  getLiveError() { return this.liveError; }

  /** Serialises all state-changing work. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Engine clock: ORIGINAL event time in replay; wall-clock time in live. */
  clock(): number {
    if (this.mode === 'replay' && this.replay) return this.replay.event.start + this.replay.step * this.replay.event.step_min * MIN;
    return Date.now();
  }

  private replayInfo(): ReplayInfo | null {
    if (this.mode !== 'replay' || !this.replay) return null;
    const r = this.replay;
    return {
      event_id: r.event.id, event_name: r.event.name, step: r.step,
      total_steps: Math.floor((r.event.end - r.event.start) / (r.event.step_min * MIN)), step_min: r.event.step_min,
      original_time: new Date(this.clock()).toISOString(), replayed_at: new Date().toISOString(),
      playing: r.playing, speed: r.speed,
    };
  }

  private dataModes(): DataMode[] { return MODES_FOR[this.mode]; }

  private async inputs(): Promise<Inputs> {
    const modes = this.dataModes();
    const [stored, decisions, roadEvents, assignments, rejected] = await Promise.all([
      this.repo.listReports(modes), this.repo.listDecisions(modes), this.repo.listRoadEvents(modes),
      this.repo.listAssignments(modes), this.repo.listRejections(modes),
    ]);
    const ev = this.mode === 'replay' ? this.replay?.event : undefined;
    const rain: RainObservation[] = ev ? ev.rain : await this.repo.listRain(['live'], new Date(Date.now() - 5 * 24 * HOUR).toISOString());
    return {
      mode: this.mode, replay: this.replayInfo(), rain, water: ev ? ev.water : [],
      reports: [...(ev?.reports ?? []), ...stored], decisions, roadEvents: [...(ev?.roadEvents ?? []), ...roadEvents],
      units: this.unitsWithStatus(assignments), assignments, rejected,
    };
  }

  private unitsWithStatus(assignments: Assignment[]): Unit[] {
    const active = new Map(assignments.filter((a) => ['assigned', 'en_route', 'on_scene'].includes(a.status)).map((a) => [a.unit_id, a]));
    return this.geo.units.map((u) => {
      const a = active.get(u.id);
      return a ? { ...u, status: a.status as Unit['status'] } : u;
    });
  }

  /** Evaluates at the current clock, records history, notifies listeners. Call inside run(). */
  private async evaluateNow(opts: { broadcast?: boolean; audit?: boolean } = {}): Promise<Situation> {
    const inputs = await this.inputs();
    const prev = this.situation;
    const sit = evaluate(this.world, inputs, this.clock(), prev);
    const prevVersions = new Map((prev?.warnings ?? []).map((w) => [w.settlement_id, w.version]));
    const recordMode: DataMode = this.mode === 'live' ? 'live' : 'replay';
    for (const w of sit.warnings) {
      if (w.version > 0 && w.version !== prevVersions.get(w.settlement_id)) await this.repo.recordWarningVersion(recordMode, w);
    }
    for (const c of opts.audit === false ? [] : sit.changes) {
      if (['warning_escalated', 'warning_downgraded', 'warning_created', 'settlement_cut_off'].includes(c.type)
        || (c.type === 'road_status_changed' && /BLOCKED/.test(c.message))) {
        await this.repo.audit(this.mode, 'engine', c.type, { message: c.message, engine_time: sit.as_of });
      }
    }
    this.situation = sit;
    if (this.mode === 'replay' && this.replay) this.stepCache.set(this.replay.step, { rev: this.inputRev, situation: sit });
    if (opts.broadcast !== false) for (const l of this.listeners) l(sit);
    return sit;
  }

  refresh() { return this.run(() => this.evaluateNow()); }

  // ── Replay ──────────────────────────────────────────────────────────────────

  events() { return listEvents(); }

  /**
   * Moves the replay to `target`. Uses the cached result for that step when no one has added an input
   * since it was computed; otherwise re-evaluates from step 0 so hysteresis and version history are
   * exactly reproduced.
   */
  private async recomputeReplayTo(target: number) {
    if (this.mode !== 'replay' || !this.replay) { await this.evaluateNow(); return; }
    const cached = this.stepCache.get(target);
    if (cached && cached.rev === this.inputRev) {
      this.replay.step = target;
      this.situation = { ...cached.situation, replay: this.replayInfo() };
      await this.repo.db.query('DELETE FROM warning_versions WHERE mode = $1 AND as_of > $2', ['replay', new Date(this.clock()).toISOString()]);
      for (const l of this.listeners) l(this.situation);
      await this.saveReplayState();
      return;
    }
    await this.repo.db.query('DELETE FROM warning_versions WHERE mode = $1', ['replay']);
    this.stepCache.clear();
    this.situation = null;
    // Steps being re-computed (step back / restart) were already audited when first played.
    const recomputing = target > 0;
    for (let s = 0; s <= target; s++) {
      this.replay.step = s;
      await this.evaluateNow({ broadcast: s === target, audit: !recomputing });
    }
    await this.saveReplayState();
  }

  private async saveReplayState() {
    if (this.replay) await this.repo.setState('replay', { event_id: this.replay.event.id, step: this.replay.step, speed: this.replay.speed });
  }

  startReplay(eventId: string, actor: string) {
    return this.run(async () => {
      if (this.mode !== 'replay') throw new HttpError(409, 'wrong_mode', 'Switch to REPLAY mode first');
      this.stopTimer();
      await this.repo.clearReplayRun();
      this.stepCache.clear();
      this.replay = { event: this.loadEventOrThrow(eventId), step: 0, playing: true, speed: this.replay?.speed ?? 1, timer: null };
      await this.repo.audit('replay', actor, 'replay_started', { event_id: eventId });
      await this.recomputeReplayTo(0);
      this.startTimer();
      return this.situation!;
    });
  }

  private startTimer() {
    this.stopTimer();
    const r = this.replay;
    if (!r || !r.playing) return;
    r.timer = setInterval(() => {
      void this.run(async () => {
        if (!this.replay?.playing) return;
        const total = Math.floor((this.replay.event.end - this.replay.event.start) / (this.replay.event.step_min * MIN));
        if (this.replay.step >= total) { this.replay.playing = false; this.stopTimer(); await this.evaluateNow(); return; }
        this.replay.step++;
        await this.evaluateNow();
        await this.saveReplayState();
      }).catch((err) => console.error('[replay]', err));
    }, STEP_MS_AT_1X / r.speed);
  }

  private stopTimer() {
    if (this.replay?.timer) { clearInterval(this.replay.timer); this.replay.timer = null; }
  }

  replayControl(action: 'play' | 'pause' | 'forward' | 'back' | 'speed', value?: number) {
    return this.run(async () => {
      if (this.mode !== 'replay' || !this.replay) throw new HttpError(409, 'no_replay', 'No replay loaded');
      const r = this.replay;
      const total = Math.floor((r.event.end - r.event.start) / (r.event.step_min * MIN));
      if (action === 'play') { r.playing = true; this.startTimer(); await this.evaluateNow(); }
      else if (action === 'pause') { r.playing = false; this.stopTimer(); await this.evaluateNow(); }
      else if (action === 'forward') { if (r.step < total) { r.step++; await this.evaluateNow(); await this.saveReplayState(); } }
      else if (action === 'back') { if (r.step > 0) await this.recomputeReplayTo(r.step - 1); }
      else if (action === 'speed') {
        if (!REPLAY_SPEEDS.includes(value ?? 0)) throw new HttpError(400, 'bad_speed', `Speed must be one of ${REPLAY_SPEEDS.join(', ')}`);
        r.speed = value!;
        if (r.playing) this.startTimer();
        await this.saveReplayState();
        await this.evaluateNow();
      }
      return this.situation!;
    });
  }

  // ── Mode ────────────────────────────────────────────────────────────────────

  setMode(mode: SystemMode, actor: string) {
    return this.run(async () => {
      if (mode === this.mode) return this.situation!;
      this.stopTimer();
      await this.repo.audit(mode, actor, 'mode_changed', { from: this.mode, to: mode });
      this.mode = mode;
      await this.repo.setState('mode', mode);
      this.situation = null; // never carry replay state into live (or back)
      this.stepCache.clear();
      if (mode === 'live') {
        this.startLivePolling();
        await this.pollLiveOnce();
      } else {
        this.stopLivePolling();
        const eventId = this.replay?.event.id ?? listEvents().find((e) => e.has_scenario)?.id;
        if (eventId && !this.replay) this.replay = { event: this.loadEventOrThrow(eventId), step: 0, playing: false, speed: 1, timer: null };
        if (this.replay) this.replay.playing = false;
        await this.recomputeReplayTo(this.replay?.step ?? 0);
        return this.situation!;
      }
      return this.evaluateNow();
    });
  }

  private startLivePolling() {
    this.stopLivePolling();
    this.livePoll = setInterval(() => { void this.run(() => this.pollLiveOnce().then(() => this.evaluateNow())).catch((e) => console.error('[live]', e)); }, LIVE_POLL_MS);
  }
  private stopLivePolling() { if (this.livePoll) { clearInterval(this.livePoll); this.livePoll = null; } }

  private async pollLiveOnce() {
    try {
      await this.repo.upsertRain(await fetchLiveRain(this.cells));
      this.liveError = null;
    } catch (err) {
      // No invented values: the engine reports missing/stale rainfall as a data gap.
      this.liveError = `Live rainfall unavailable: ${(err as Error).message}`;
      console.warn(`[live] ${this.liveError}`);
    }
  }

  // ── Inputs from people ──────────────────────────────────────────────────────

  submitReport(body: { text: string; lat?: number; lng?: number; accuracy_m?: number; settlement_id?: string }, reporterRef: string) {
    return this.run(async () => {
      const text = body.text?.trim();
      if (!text || text.length < 5) throw new HttpError(400, 'text_required', 'Please describe what is happening.');
      if (text.length > 2000) throw new HttpError(400, 'text_too_long', 'Report is too long (max 2000 characters).');
      const loc = this.resolveLocation(body);
      const { evidence, model, fallback_reason } = await extractEvidence(text);
      const report: GroundReport = {
        id: crypto.randomUUID(), text, received_at: new Date(this.clock()).toISOString(), lat: loc.lat, lng: loc.lng,
        location_confidence: loc.confidence, reporter_ref: reporterRef, evidence, verification: 'unverified',
        mode: inputModeFor(this.mode),
      };
      this.inputRev++; // new input: cached replay steps are no longer valid
      await this.repo.insertReport(report, { location_method: loc.method, extraction: { model, fallback_reason } });
      await this.repo.audit(this.mode, reporterRef, 'report_received', { report_id: report.id, kinds: evidence.kinds, extractor: evidence.extractor });
      await this.evaluateNow();
      return { report, extraction: { model, fallback_reason } };
    });
  }

  /** GPS (≤150 m accurate) → 0.9; chosen settlement → 0.7; otherwise the report is refused (never guessed). */
  private resolveLocation(b: { lat?: number; lng?: number; accuracy_m?: number; settlement_id?: string }) {
    if (typeof b.lat === 'number' && typeof b.lng === 'number' && Number.isFinite(b.lat) && Number.isFinite(b.lng)) {
      const inArea = this.geo.settlements.some((s) => haversineM(s, { lat: b.lat!, lng: b.lng! }) <= 10_000);
      if (!inArea) throw new HttpError(422, 'outside_area', 'This location is outside the Kolhapur study area.');
      const acc = b.accuracy_m ?? 1000;
      return { lat: b.lat, lng: b.lng, confidence: acc <= 150 ? 0.9 : acc <= 500 ? 0.7 : 0.5, method: `gps ±${Math.round(acc)} m` };
    }
    const s = b.settlement_id ? this.geo.settlements.find((x) => x.id === b.settlement_id) : undefined;
    if (s) return { lat: s.lat, lng: s.lng, confidence: 0.7, method: `settlement chosen by reporter (${s.name})` };
    throw new HttpError(422, 'location_required', 'Share your location or choose your village / area.');
  }

  verifyReport(reportId: string, decision: 'verified' | 'disputed', actor: string, note: string | null) {
    return this.run(async () => {
      const known = this.situation?.reports.some((r) => r.id === reportId);
      if (!known) throw new HttpError(404, 'not_found', 'Report not found in the current view');
      this.inputRev++; // new input: cached replay steps are no longer valid
      await this.repo.decide(reportId, inputModeFor(this.mode), decision, actor, note);
      await this.repo.audit(this.mode, actor, `report_${decision}`, { report_id: reportId, note });
      return this.evaluateNow();
    });
  }

  setRoad(segmentId: string, action: 'close' | 'reopen', reason: string, actor: string) {
    return this.run(async () => {
      if (!this.world.graph.segments.has(segmentId)) throw new HttpError(404, 'not_found', 'Unknown road segment');
      if (!reason?.trim()) throw new HttpError(400, 'reason_required', 'A reason is required');
      this.inputRev++; // new input: cached replay steps are no longer valid
      await this.repo.insertRoadEvent({
        id: crypto.randomUUID(), segment_id: segmentId, action, at: new Date(this.clock()).toISOString(), reason: reason.trim(),
        origin: 'coordinator', source: actor, mode: inputModeFor(this.mode),
      }, actor);
      await this.repo.audit(this.mode, actor, action === 'close' ? 'road_closed' : 'road_reopened', { segment_id: segmentId, reason });
      return this.evaluateNow();
    });
  }

  // ── Coordinator decisions (the only way anything is dispatched) ────────────

  approve(recommendationId: string, actor: string) {
    return this.run(async () => {
      // Re-evaluate first: approval is checked against the CURRENT situation (staleness check).
      const sit = await this.evaluateNow({ broadcast: false });
      const rec = sit.recommendations.find((r) => r.id === recommendationId);
      if (!rec) throw new HttpError(409, 'stale_recommendation', 'Conditions changed since this was proposed. Review the updated recommendations.');
      const now = new Date(this.clock()).toISOString();
      const mode = inputModeFor(this.mode);
      const active = sit.assignments.filter((a) => ['assigned', 'en_route', 'on_scene'].includes(a.status));
      if (rec.kind === 'reroute') {
        const a = active.find((x) => x.unit_id === rec.unit_id && x.settlement_id === rec.settlement_id);
        if (!a) throw new HttpError(409, 'stale_recommendation', 'The assignment to reroute no longer exists.');
        await this.repo.updateAssignment(a.id, { route: rec.route, eta_min: rec.eta_min, staging_note: rec.staging_note }, now);
      } else {
        if (rec.kind === 'reassign') {
          const cur = active.find((x) => x.unit_id === rec.unit_id);
          if (cur) await this.repo.updateAssignment(cur.id, { status: 'cancelled' }, now);
        }
        if (rec.kind === 'replacement') {
          const unitType = this.geo.units.find((u) => u.id === rec.unit_id)?.type;
          const broken = active.find((x) => x.settlement_id === rec.settlement_id && this.geo.units.find((u) => u.id === x.unit_id)?.type === unitType
            && x.route.segment_ids.some((id) => sit.roads.some((r) => r.segment_id === id && r.status === 'BLOCKED')));
          if (broken) await this.repo.updateAssignment(broken.id, { status: 'cancelled' }, now);
        }
        try {
          await this.repo.insertAssignment({
            id: crypto.randomUUID(), unit_id: rec.unit_id, settlement_id: rec.settlement_id, status: 'assigned', route: rec.route,
            eta_min: rec.eta_min, staging_note: rec.staging_note, approved_by: actor, approved_at: now, updated_at: now,
          }, mode, rec.id);
        } catch {
          throw new HttpError(409, 'unit_busy', 'This unit already has an active assignment.');
        }
      }
      this.inputRev++;
      await this.repo.audit(this.mode, actor, 'recommendation_approved', { recommendation_id: rec.id, kind: rec.kind, unit_id: rec.unit_id, settlement_id: rec.settlement_id, eta_min: rec.eta_min, reasons: rec.reasons });
      return this.evaluateNow();
    });
  }

  reject(recommendationId: string, actor: string) {
    return this.run(async () => {
      const rec = this.situation?.recommendations.find((r) => r.id === recommendationId);
      if (!rec) throw new HttpError(409, 'stale_recommendation', 'This recommendation is no longer current.');
      this.inputRev++; // new input: cached replay steps are no longer valid
      await this.repo.reject(inputModeFor(this.mode), rec.unit_id, rec.settlement_id, actor);
      await this.repo.audit(this.mode, actor, 'recommendation_rejected', { recommendation_id: rec.id });
      return this.evaluateNow();
    });
  }

  /** Field units move their own assignment forward; coordinators can also cancel. */
  updateAssignment(id: string, status: Assignment['status'], user: { username: string; role: string; unit_id: string | null }) {
    return this.run(async () => {
      const a = this.situation?.assignments.find((x) => x.id === id);
      if (!a) throw new HttpError(404, 'not_found', 'Assignment not found');
      if (user.role === 'field' && user.unit_id !== a.unit_id) throw new HttpError(403, 'forbidden', 'You can only update your own unit');
      const allowed: Record<string, Assignment['status'][]> = {
        assigned: ['en_route', 'cancelled'], en_route: ['on_scene', 'cancelled'], on_scene: ['completed'],
      };
      if (!allowed[a.status]?.includes(status)) throw new HttpError(409, 'bad_transition', `Cannot go from ${a.status} to ${status}`);
      if (status === 'cancelled' && user.role === 'field') throw new HttpError(403, 'forbidden', 'Only a coordinator can cancel');
      this.inputRev++; // new input: cached replay steps are no longer valid
      await this.repo.updateAssignment(id, { status }, new Date(this.clock()).toISOString());
      await this.repo.audit(this.mode, user.username, `assignment_${status}`, { assignment_id: id, unit_id: a.unit_id });
      return this.evaluateNow();
    });
  }

  warningHistory(settlementId: string) {
    return this.repo.warningHistory([this.mode === 'live' ? 'live' : 'replay'], settlementId);
  }
  audit(limit = 200) { return this.repo.listAudit([this.mode], limit); }
}
