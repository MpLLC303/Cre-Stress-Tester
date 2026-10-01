import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../sidecar/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-'));
const logFile = (dir) => path.join(dir, 'events.ndjson');
const station = { name: 'T', rooms: [], hallways: [], agents: [{ id: 'nova', room: 'r' }] };

function captureStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: fn(), lines };
  } finally {
    console.error = original;
  }
}

test('append assigns seq and ts, persists, applies and notifies', () => {
  const dir = tmp();
  const store = createStore({ dataDir: dir });
  const seen = [];
  const unsubscribe = store.subscribe((e) => seen.push(e));

  const e1 = store.append('station.loaded', { station });
  const e2 = store.append('agent.status', { agentId: 'nova', status: 'thinking' }, 'nova');
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e2.actor, 'nova');
  assert.equal(e1.actor, 'system');
  assert.ok(!Number.isNaN(Date.parse(e1.ts)));
  assert.equal(store.state.seq, 2);
  assert.equal(store.state.agents.nova.status, 'thinking');
  assert.deepEqual(seen.map((e) => e.seq), [1, 2]);

  unsubscribe();
  store.append('log', { level: 'info', message: 'after unsubscribe' });
  assert.equal(seen.length, 2);

  const lines = fs.readFileSync(logFile(dir), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[2]).payload.message, 'after unsubscribe');
  store.close();
});

test('invalid payloads throw and leave the log untouched', () => {
  const dir = tmp();
  const store = createStore({ dataDir: dir });
  assert.throws(() => store.append('agent.status', { agentId: 'nova', status: 'dancing' }), /agent\.status/);
  assert.throws(() => store.append('no.such.event', {}), /unknown event type/);
  assert.equal(store.state.seq, 0);
  assert.equal(store.events().length, 0);
  store.close();
  assert.equal(fs.readFileSync(logFile(dir), 'utf8'), '');
});

test('events(sinceSeq) returns events after the given seq', () => {
  const store = createStore({ dataDir: tmp() });
  for (let i = 0; i < 5; i++) store.append('log', { level: 'info', message: `m${i}` });
  assert.deepEqual(store.events().map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(store.events(3).map((e) => e.seq), [4, 5]);
  assert.deepEqual(store.events(5), []);
  store.close();
});

test('a throwing subscriber does not break append', () => {
  const store = createStore({ dataDir: tmp() });
  store.subscribe(() => {
    throw new Error('boom');
  });
  const { result, lines } = captureStderr(() => store.append('log', { level: 'warn', message: 'x' }));
  assert.equal(result.seq, 1);
  assert.equal(store.state.seq, 1);
  assert.match(lines.join('\n'), /subscriber failed/);
  store.close();
});

test('reopening replays the log into an identical state', () => {
  const dir = tmp();
  const a = createStore({ dataDir: dir });
  a.append('station.loaded', { station });
  a.append('task.created', { taskId: 't1', title: 'T', brief: 'b', assignee: 'nova', createdBy: 'operator', inputs: ['art_1'] });
  a.append('task.status', { taskId: 't1', status: 'running' });
  const before = structuredClone(a.state);
  a.close();
  const b = createStore({ dataDir: dir });
  assert.deepEqual(b.state, before);
  assert.equal(b.append('log', { level: 'info', message: 'next' }).seq, 4);
  b.close();
});

test('a torn final line is dropped, logged, and truncated so appends stay clean', () => {
  const dir = tmp();
  const a = createStore({ dataDir: dir });
  a.append('log', { level: 'info', message: 'one' });
  a.append('log', { level: 'info', message: 'two' });
  a.close();
  fs.appendFileSync(logFile(dir), '{"seq":3,"ts":"2026-10-01T00:00:00.000Z","type":"log","act');

  const { result: b, lines } = captureStderr(() => createStore({ dataDir: dir }));
  assert.match(lines.join('\n'), /torn final line/);
  assert.equal(b.state.seq, 2);
  assert.deepEqual(b.events().map((e) => e.payload.message), ['one', 'two']);
  assert.equal(b.append('log', { level: 'info', message: 'three' }).seq, 3);
  b.close();

  const c = createStore({ dataDir: dir });
  assert.deepEqual(c.events().map((e) => e.payload.message), ['one', 'two', 'three']);
  c.close();
});

test('a complete final line missing its newline is kept', () => {
  const dir = tmp();
  const a = createStore({ dataDir: dir });
  a.append('log', { level: 'info', message: 'one' });
  a.close();
  fs.writeFileSync(logFile(dir), fs.readFileSync(logFile(dir), 'utf8').trimEnd());
  const b = createStore({ dataDir: dir });
  assert.equal(b.state.seq, 1);
  b.append('log', { level: 'info', message: 'two' });
  b.close();
  const c = createStore({ dataDir: dir });
  assert.equal(c.state.seq, 2);
  c.close();
});

test('a malformed middle line throws instead of silently skipping history', () => {
  const dir = tmp();
  const a = createStore({ dataDir: dir });
  a.append('log', { level: 'info', message: 'one' });
  a.append('log', { level: 'info', message: 'two' });
  a.close();
  const [first, second] = fs.readFileSync(logFile(dir), 'utf8').trim().split('\n');
  fs.writeFileSync(logFile(dir), `${first}\n{not json\n${second}\n`);
  assert.throws(() => createStore({ dataDir: dir }), /malformed event/);
});

test('append after close throws', () => {
  const store = createStore({ dataDir: tmp() });
  store.close();
  store.close();
  assert.throws(() => store.append('log', { level: 'info', message: 'late' }), /closed/);
});

test('a failed write (short write + ENOSPC) is cut off and the store turns read-only (RT-2)', () => {
  const dir = tmp();
  const io = { fail: false };
  // A short write: part of the line reaches the file, then the disk is full.
  const writeImpl = (fd, data) => {
    if (!io.fail) return fs.appendFileSync(fd, data);
    fs.appendFileSync(fd, data.slice(0, 20));
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  };
  const store = createStore({ dataDir: dir, writeImpl });
  store.append('log', { level: 'info', message: 'one' });
  const before = fs.readFileSync(logFile(dir), 'utf8');
  const notified = [];
  store.onFailure((msg) => notified.push(msg));
  const seen = [];
  store.subscribe((e) => seen.push(e.seq));

  io.fail = true;
  const { lines } = captureStderr(() => assert.throws(() => store.append('log', { level: 'info', message: 'two' }), /no space/));
  assert.match(lines.join('\n'), /read-only until restart/);
  assert.equal(fs.readFileSync(logFile(dir), 'utf8'), before, 'the fragment is cut off: the file ends on a whole event');
  assert.equal(store.state.seq, 1, 'nothing was applied');
  assert.deepEqual(seen, [], 'nothing was announced');
  assert.deepEqual(store.health(), { failed: 'ENOSPC: no space left on device' });
  assert.deepEqual(notified, ['ENOSPC: no space left on device']);

  io.fail = false; // space freed: still read-only, so no later event can merge into a fragment
  assert.throws(() => store.append('log', { level: 'info', message: 'three' }), /read-only after a write failure/);
  store.close();
  const reopened = createStore({ dataDir: dir });
  assert.deepEqual(reopened.events().map((e) => e.payload.message), ['one'], 'a restart recovers cleanly');
  assert.equal(reopened.append('log', { level: 'info', message: 'two' }).seq, 2);
  reopened.close();
});

test('events(since, limit) pages the log; logId names the log by its first event', () => {
  const a = createStore({ dataDir: tmp() });
  assert.equal(a.logId(), null, 'an empty log has no identity yet');
  for (let i = 1; i <= 5; i += 1) a.append('log', { level: 'info', message: `m${i}` });
  assert.deepEqual(a.events(1, 2).map((e) => e.seq), [2, 3]);
  assert.deepEqual(a.events(4, 10).map((e) => e.seq), [5]);
  assert.deepEqual(a.events(5, 10), []);
  const id = a.logId();
  assert.match(id, /^[0-9a-f]{16}$/);
  const dir = tmp();
  const b = createStore({ dataDir: dir });
  b.append('log', { level: 'info', message: 'another log' });
  assert.notEqual(b.logId(), id, 'another log (same seqs) has another identity');
  b.close();
  const again = createStore({ dataDir: dir });
  assert.equal(again.logId(), b.logId(), 'stable across restarts');
  again.close();
  a.close();
});
