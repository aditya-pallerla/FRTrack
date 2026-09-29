/**
 * Replay determinism check: runs the whole replay twice, headless (no database, no network), and
 * compares a fingerprint of every step. Also prints the storyline (warnings, closures, cut-offs,
 * priority changes) so the demo script can be checked against what the data actually produces.
 *
 *   npm run replay:check [event_id]
 */
import crypto from 'node:crypto';
import type { Situation } from '../../shared/types.js';
import { loadGeography } from '../src/data/geography.js';
import { buildWorld, evaluate } from '../src/engine/evaluate.js';
import { MIN, formatIst } from '../src/engine/time.js';
import { listEvents, loadEvent } from '../src/replay/event.js';

const geo = loadGeography();
const eventId = process.argv[2] ?? listEvents().find((e) => e.has_scenario)?.id;
if (!eventId) throw new Error('No replay event with a scenario found');
const hosting = new Set(geo.units.map((u) => u.base_id));

function runOnce(print: boolean): string[] {
  const world = buildWorld(geo.settlements, geo.segments, geo.bases.filter((b) => hosting.has(b.id)), geo.gauges);
  const ev = loadEvent(eventId!, geo.settlements, geo.segments);
  if (print) for (const w of ev.warnings) console.log(`  scenario warning: ${w}`);
  const steps = Math.floor((ev.end - ev.start) / (ev.step_min * MIN));
  let prev: Situation | null = null;
  const prints: string[] = [];
  const name = new Map(geo.settlements.map((s) => [s.id, s.name]));
  for (let k = 0; k <= steps; k++) {
    const now = ev.start + k * ev.step_min * MIN;
    const sit = evaluate(world, {
      mode: 'replay', replay: null, rain: ev.rain, water: ev.water, reports: ev.reports, decisions: new Map(), roadEvents: ev.roadEvents,
      units: geo.units, assignments: [], rejected: new Set(),
    }, now, prev);
    prints.push(crypto.createHash('sha1').update(JSON.stringify({
      w: sit.warnings.map((w) => [w.settlement_id, w.level, w.risk, w.confidence.value, w.version]),
      r: sit.roads.map((r) => [r.segment_id, r.status]), a: sit.access.map((a) => [a.settlement_id, a.status, a.route?.duration_s]),
      p: sit.priorities.map((p) => [p.settlement_id, p.rank, p.score]), rec: sit.recommendations.map((r) => r.id),
    })).digest('hex'));
    if (print) {
      const important = sit.changes.filter((c) => c.type !== 'priority_changed' || /#[1-5] /.test(c.message)).filter((c) => c.type !== 'road_status_changed' || /BLOCKED/.test(c.message));
      if (important.length) {
        const counts = ['SEVERE', 'WARNING', 'WATCH'].map((l) => `${l[0]}${sit.warnings.filter((w) => w.level === l).length}`).join(' ');
        console.log(`\n[step ${k}] ${formatIst(now)}  (${counts}, recs ${sit.recommendations.length})`);
        for (const c of important.slice(0, 12)) console.log(`   ${c.type.padEnd(22)} ${c.message.slice(0, 160)}`);
        if (important.length > 12) console.log(`   … ${important.length - 12} more`);
      }
      if (k === steps) {
        console.log('\nTop priorities at the end:');
        for (const p of sit.priorities.slice(0, 5)) console.log(`   #${p.rank} ${name.get(p.settlement_id)} ${p.band} ${p.score}`);
      }
    }
    prev = sit;
  }
  return prints;
}

const t0 = performance.now();
const a = runOnce(true);
const t1 = performance.now();
const b = runOnce(false);
const same = a.length === b.length && a.every((x, i) => x === b[i]);
console.log(`\n${a.length} steps; run 1 took ${Math.round(t1 - t0)} ms, run 2 ${Math.round(performance.now() - t1)} ms`);
console.log(same ? 'DETERMINISTIC: both runs produced identical results at every step.' : 'NOT DETERMINISTIC: runs differ!');
if (!same) process.exitCode = 1;
