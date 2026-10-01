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
