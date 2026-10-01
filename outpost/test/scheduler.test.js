import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../sidecar/store.js';
import { createScheduler, cronMatches, parseSpec } from '../sidecar/scheduler.js';
import { createDispatcher } from '../sidecar/dispatcher.js';

const station = JSON.parse(fs.readFileSync(new URL('../config/station.json', import.meta.url), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-'));
const at = (iso) => Date.parse(iso);

function fakeDispatcher() {
  const calls = [];
  let n = 0;
  return {
    calls,
    startRecipe: (name, params, createdBy) => {
      calls.push(['startRecipe', name, params, createdBy]);
      return { recipeRunId: `rr_${++n}`, taskIds: [`task_r${n}a`, `task_r${n}b`] };
    },
    createTask: (spec) => {
      calls.push(['createTask', spec]);
      return `task_${++n}`;
    },
  };
}

function setup(start = '2026-10-01T08:00:10.000Z', dataDir = tmp()) {
  const clock = { t: typeof start === 'number' ? start : at(start) };
  const store = createStore({ dataDir });
  if (!store.state.station) store.append('station.loaded', { station });
  const dispatcher = fakeDispatcher();
  const scheduler = createScheduler({ store, dispatcher, now: () => clock.t });
  return { clock, store, dispatcher, scheduler, dataDir };
}

const fired = (store) => store.events().filter((e) => e.type === 'schedule.fired');

test('parseSpec: intervals', () => {
  assert.deepEqual(parseSpec('every 15m'), { kind: 'interval', spec: 'every 15m', ms: 15 * 60_000 });
  assert.deepEqual(parseSpec('  Every 2 H '), { kind: 'interval', spec: 'every 2h', ms: 2 * 3_600_000 });
  assert.throws(() => parseSpec('every 0m'), /at least 1/);
  assert.throws(() => parseSpec('every 5s'), /5-field cron/);
});

test('parseSpec: cron fields with *, */n, ranges and lists', () => {
  const c = parseSpec('*/15 9-17 1,15 * 1-5');
  assert.equal(c.kind, 'cron');
  assert.deepEqual([...c.minute], [0, 15, 30, 45]);
  assert.deepEqual([...c.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...c.dom], [1, 15]);
  assert.equal(c.month.size, 12);
  assert.deepEqual([...c.dow], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseSpec('0 0 * * 7').dow], [0], 'day-of-week 7 is Sunday');
  for (const bad of ['60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '5-1 * * * *', '*/0 * * * *', 'a * * * *', '* * * *', '1,,2 * * * *']) {
    assert.throws(() => parseSpec(bad), Error, bad);
  }
});

test('cronMatches works in UTC and ORs day-of-month with day-of-week when both are restricted', () => {
  const c = parseSpec('30 6 * * *');
  assert.equal(cronMatches(c, at('2026-10-01T06:30:59Z')), true);
  assert.equal(cronMatches(c, at('2026-10-01T06:31:00Z')), false);
  const both = parseSpec('0 12 13 * 5'); // the 13th, or any Friday
  assert.equal(cronMatches(both, at('2026-10-13T12:00:00Z')), true); // Tuesday the 13th
  assert.equal(cronMatches(both, at('2026-10-02T12:00:00Z')), true); // Friday the 2nd
  assert.equal(cronMatches(both, at('2026-10-01T12:00:00Z')), false); // Thursday the 1st
  const weekdays = parseSpec('0 12 * * 1-5');
  assert.equal(cronMatches(weekdays, at('2026-10-03T12:00:00Z')), false); // Saturday
});

test('a day field starting with * (including */n) is unrestricted, as in Vixie cron and cronie (RT-10)', () => {
  const daysIn = (spec) => {
    const c = parseSpec(spec);
    const days = [];
    for (let d = 1; d <= 31; d += 1) if (cronMatches(c, Date.UTC(2026, 9, d, 9, 0))) days.push(d);
    return days;
  };
  const oddWeekdays = parseSpec('0 9 */2 * 1-5');
  assert.deepEqual([oddWeekdays.domAny, oddWeekdays.dowAny], [true, false]);
  assert.deepEqual(daysIn('0 9 */2 * 1-5'), [1, 5, 7, 9, 13, 15, 19, 21, 23, 27, 29], 'odd days AND weekdays (cronie)');
  assert.deepEqual(daysIn('0 9 13 * */2'), [13], 'the 13th, a Tuesday (day 2), AND an even weekday');
  assert.deepEqual(daysIn('0 9 1,15 * 1'), [1, 5, 12, 15, 19, 26], 'both restricted: the 1st, the 15th OR any Monday');
});

test('addSchedule validates and emits schedule.created', () => {
  const { store, scheduler } = setup();
  const id = scheduler.addSchedule('every 30m', { recipe: 'ledger_report', params: {} });
  const [ev] = store.events().filter((e) => e.type === 'schedule.created');
  assert.deepEqual(ev.payload, { scheduleId: id, spec: 'every 30m', template: { recipe: 'ledger_report', params: {} }, enabled: true });
  assert.equal(ev.actor, 'operator');
  assert.throws(() => scheduler.addSchedule('every 30m', { recipe: 'nope' }), /unknown recipe/);
  assert.throws(() => scheduler.addSchedule('every 30m', { recipe: 'pod_listing', params: { colour: 'red' } }), /no param/);
  assert.throws(() => scheduler.addSchedule('every 30m', { task: { assignee: 'ghost', title: 't', brief: 'b' } }), /unknown agent/);
  assert.throws(() => scheduler.addSchedule('every 30m', { task: { assignee: 'nova', title: '', brief: 'b' } }), /title/);
  assert.throws(() => scheduler.addSchedule('whenever', { recipe: 'ledger_report' }), /cron/);
  assert.equal(Object.keys(store.state.schedules).length, 1);
});

test('interval schedules fire recipes when due, at most once per minute', () => {
  const { clock, store, dispatcher, scheduler } = setup();
  const id = scheduler.addSchedule('every 1m', { recipe: 'competitor_scan', params: { market: 'mugs' } });
  assert.deepEqual(scheduler.tick(), []);
  clock.t += 30_000;
  assert.deepEqual(scheduler.tick(), []);
  clock.t += 30_000;
  assert.deepEqual(scheduler.tick(), [id]);
  assert.deepEqual(scheduler.tick(), [], 'no second firing in the same minute');
  assert.deepEqual(dispatcher.calls, [['startRecipe', 'competitor_scan', { market: 'mugs' }, 'scheduler']]);
  const [ev] = fired(store);
  assert.deepEqual(ev.payload, { scheduleId: id, taskIds: ['task_r1a', 'task_r1b'] });
  assert.equal(ev.actor, 'scheduler');
  assert.equal(store.state.schedules[id].fired, 1);
  clock.t += 60_000;
  assert.deepEqual(scheduler.tick(), [id]);
  assert.equal(fired(store).length, 2);
});

test('cron schedules fire task templates in the matching UTC minute only', () => {
  const { clock, store, dispatcher, scheduler } = setup('2026-10-01T08:59:50.000Z');
  const id = scheduler.addSchedule('0 9 * * *', { task: { assignee: 'tally', title: 'Morning books', brief: 'Sync and report.' } });
  assert.deepEqual(scheduler.tick(), []);
  clock.t = at('2026-10-01T09:00:05Z');
  assert.deepEqual(scheduler.tick(), [id]);
  clock.t = at('2026-10-01T09:00:45Z');
  assert.deepEqual(scheduler.tick(), []);
  clock.t = at('2026-10-01T09:01:00Z');
  assert.deepEqual(scheduler.tick(), []);
  assert.deepEqual(dispatcher.calls, [['createTask', { assignee: 'tally', title: 'Morning books', brief: 'Sync and report.', createdBy: 'scheduler' }]]);
  assert.deepEqual(fired(store)[0].payload.taskIds, ['task_1']);
  clock.t = at('2026-10-02T09:00:00Z');
  assert.deepEqual(scheduler.tick(), [id]);
});

test('E-STOP holds schedules; a failing template is logged and retried at its next due time', () => {
  const { clock, store, scheduler, dispatcher } = setup();
  const id = scheduler.addSchedule('every 1m', { recipe: 'ledger_report' });
  store.append('estop', { engaged: true });
  clock.t += 60_000;
  assert.deepEqual(scheduler.tick(), []);
  store.append('estop', { engaged: false });
  assert.deepEqual(scheduler.tick(), [id]);

  dispatcher.startRecipe = () => { throw new Error('dispatcher offline'); };
  clock.t += 60_000;
  assert.deepEqual(scheduler.tick(), []);
  assert.deepEqual(scheduler.tick(), [], 'not retried within the same minute');
  const logs = store.events().filter((e) => e.type === 'log');
  assert.equal(logs.length, 1);
  assert.match(logs[0].payload.message, /dispatcher offline/);
  assert.equal(fired(store).length, 1);
});

test('schedules are restored from the event log after a restart', () => {
  // The store stamps events with the real clock, so this test keeps its fake clock near real time.
  const base = Date.now();
  const fireAt = base + 5 * 60_000 + 30_000;
  const first = setup(base - 5 * 60_000 - 10_000);
  const interval = first.scheduler.addSchedule('every 5m', { recipe: 'ledger_report' });
  const cron = first.scheduler.addSchedule(`${new Date(fireAt).getUTCMinutes()} * * * *`, { task: { assignee: 'nova', title: 'Scan', brief: 'b' } });
  first.clock.t = base;
  assert.deepEqual(first.scheduler.tick(), [interval]);
  first.store.close();

  const second = setup(base + 60_000, first.dataDir);
  assert.deepEqual(Object.keys(second.store.state.schedules).sort(), [interval, cron].sort());
  assert.deepEqual(second.scheduler.tick(), [], 'the interval counts from its last logged firing');
  second.clock.t = fireAt;
  assert.deepEqual(second.scheduler.tick().sort(), [interval, cron].sort());
  second.store.close();
});

test('start/stop drive tick on a timer', async () => {
  const { store, dispatcher } = setup();
  const clock = { t: at('2026-10-01T08:00:00Z') };
  const scheduler = createScheduler({ store, dispatcher, now: () => clock.t, intervalMs: 5 });
  scheduler.addSchedule('every 1m', { recipe: 'ledger_report' });
  clock.t += 61_000;
  scheduler.start();
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  scheduler.stop();
  assert.equal(fired(store).length, 1);
});

// ---- no backlog behind a stall (RT-7) ------------------------------------------------------------

function realSetup({ dailyUsd = 15 } = {}) {
  const dataDir = tmp();
  const store = createStore({ dataDir });
  const st = structuredClone(station);
  st.budgets.stationDailyUsd = dailyUsd;
  store.append('station.loaded', { station: st });
  // Never started: queued work stays queued, as it does while the budget holds it.
  const dispatcher = createDispatcher({ store, config: { dataDir, tickMs: 60_000 }, station: st, providerFor: () => null });
  const clock = { t: Date.now() };
  const scheduler = createScheduler({ store, dispatcher, now: () => clock.t });
  return { store, dispatcher, scheduler, clock };
}

const recipeRuns = (store) => Object.keys(store.state.recipes).length;
const skipLogs = (store) => store.events().filter((e) => e.type === 'log' && /skipped/.test(e.payload.message));

test('while the daily budget holds queued work, 12 h of an every-5m schedule add no backlog', () => {
  const { store, scheduler, clock } = realSetup({ dailyUsd: 1 });
  store.append('spend.recorded', { agentId: 'pixel', category: 'image', model: 'gpt-image-2', usd: 1 });
  scheduler.addSchedule('every 5m', { recipe: 'ledger_report' });
  for (let minute = 0; minute < 12 * 60; minute += 1) {
    clock.t += 60_000;
    scheduler.tick();
  }
  assert.ok(recipeRuns(store) <= 1, `${recipeRuns(store)} recipe runs queued behind a spent budget`);
  assert.equal(skipLogs(store).length, 1, 'logged once, not every five minutes');
  assert.match(skipLogs(store)[0].payload.message, /daily budget is spent/);
});

test('a schedule skips while its previous firing is unfinished, then fires again once it is', () => {
  const { store, scheduler, clock } = realSetup();
  const id = scheduler.addSchedule('every 5m', { recipe: 'ledger_report' });
  for (let minute = 0; minute < 60; minute += 1) {
    clock.t += 60_000;
    scheduler.tick();
  }
  assert.equal(recipeRuns(store), 1, 'one firing; the next eleven found its task still queued');
  assert.equal(skipLogs(store).length, 1);
  assert.match(skipLogs(store)[0].payload.message, /previous firing still has 1 unfinished task/);
  for (const taskId of store.state.schedules[id].lastTaskIds) store.append('task.status', { taskId, status: 'done' });
  clock.t += 5 * 60_000;
  assert.deepEqual(scheduler.tick(), [id]);
  assert.equal(recipeRuns(store), 2);
});
