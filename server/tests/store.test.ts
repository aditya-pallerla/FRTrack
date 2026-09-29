/** Storage-level live/replay separation. These tests FAIL if replay rows can reach a live query. */
import { openDb } from '../src/store/db.js';
import { MODES_FOR, Repo } from '../src/store/repo.js';
import { T0, report } from './fixtures.js';
import { assert, eq, runStandalone, test } from './harness.js';

const repo = new Repo(await openDb('memory://'));
const meta = { location_method: 'test', extraction: {} };

test('a LIVE query never returns replay or synthetic reports', async () => {
  await repo.insertReport(report({ id: 'replay-1', mode: 'replay' }), meta);
  await repo.insertReport(report({ id: 'synthetic-1', mode: 'synthetic_scenario' }), meta);
  await repo.insertReport(report({ id: 'live-1', mode: 'live' }), meta);
  const live = await repo.listReports(MODES_FOR.live);
  eq(live.map((r) => r.id).join(), 'live-1', 'only the live report');
  const replay = await repo.listReports(MODES_FOR.replay);
  assert(!replay.some((r) => r.mode === 'live'), 'no live rows in replay');
});

test('replay road closures never reach the live network', async () => {
  await repo.insertRoadEvent({ id: 'E1', segment_id: 'w1_0', action: 'close', at: new Date(T0).toISOString(), reason: 't', origin: 'scenario', source: 't', mode: 'synthetic_scenario' }, null);
  eq((await repo.listRoadEvents(MODES_FOR.live)).length, 0, 'no live closures');
  eq((await repo.listRoadEvents(MODES_FOR.replay)).length, 1, 'replay closure present');
});

test('replay rainfall cannot be stored as live data', async () => {
  let threw = false;
  try {
    await repo.upsertRain([{ cell_id: 'C', lat: 0, lng: 0, observed_at: new Date(T0).toISOString(), interval_min: 60, rainfall_mm: 5, source: 't', mode: 'replay' }]);
  } catch { threw = true; }
  assert(threw, 'upsertRain must refuse non-live observations');
});

test('original timestamps survive storage unchanged', async () => {
  const at = '2021-07-22T08:40:00.000Z';
  await repo.insertReport(report({ id: 'ts-1', mode: 'synthetic_scenario', received_at: at }), meta);
  const r = (await repo.listReports(MODES_FOR.replay)).find((x) => x.id === 'ts-1')!;
  eq(new Date(r.received_at).toISOString(), at, 'received_at');
});

test('starting a new replay run clears replay inputs but never touches live rows or the audit log', async () => {
  await repo.audit('replay', 'tester', 'replay_started');
  await repo.clearReplayRun();
  eq((await repo.listReports(MODES_FOR.replay)).length, 0, 'replay reports cleared');
  eq((await repo.listReports(MODES_FOR.live)).length, 1, 'live report kept');
  eq((await repo.listAudit(['replay'])).length, 1, 'audit kept');
});

test('a unit cannot hold two active assignments', async () => {
  const a = { id: 'A1', unit_id: 'U1', settlement_id: 'S1', status: 'assigned' as const, route: { status: 'ok' as const, coords: [], segment_ids: [], distance_m: 0, duration_s: 0, uses_at_risk: [] }, eta_min: 5, staging_note: null, approved_by: 't', approved_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString() };
  await repo.insertAssignment(a, 'live', 'rec-1');
  let threw = false;
  try { await repo.insertAssignment({ ...a, id: 'A2', settlement_id: 'S2' }, 'live', 'rec-2'); } catch { threw = true; }
  assert(threw, 'database refuses a second active assignment');
});

await runStandalone('Storage and live/replay separation');
