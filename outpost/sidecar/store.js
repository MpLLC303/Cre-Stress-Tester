// Event store: the append-only NDJSON log and the live projection built from it.
//
// Every state change goes through append(): validate -> persist -> apply -> notify. On open the
// log is replayed through the same projector, so the in-memory state is always a fold of the
// file on disk.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, appendFileSync, readFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { validatePayload } from '../shared/events.js';
import { apply, initialState } from '../shared/projector.js';

const FSYNC_INTERVAL_MS = 250;

function parseLine(line, prevSeq) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  const ok = e && typeof e === 'object' && e.seq === prevSeq + 1 &&
    typeof e.type === 'string' && typeof e.ts === 'string' && e.payload && typeof e.payload === 'object';
  return ok ? e : null;
}

/**
 * Read and validate the log. A malformed final line is a torn write from a crash: it is dropped
 * (and truncated from the file so later appends start on a clean line). Anything malformed before
 * it means the log is corrupt, which must not be papered over.
 */
function replay(file) {
  if (!existsSync(file)) return [];
  const buf = readFileSync(file);
  const events = [];
  let offset = 0;
  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset);
    const end = nl === -1 ? buf.length : nl;
    const line = buf.subarray(offset, end).toString('utf8');
    const next = nl === -1 ? buf.length : nl + 1;
    if (line.trim() !== '') {
      const e = parseLine(line, events.at(-1)?.seq ?? 0);
      if (!e) {
        const isFinal = buf.subarray(next).toString('utf8').trim() === '';
        if (!isFinal) throw new Error(`${file}: malformed event at byte ${offset}; refusing to replay a corrupt log`);
        console.error(`outpost store: dropped torn final line in ${file} (${buf.length - offset} bytes)`);
        truncateSync(file, offset);
        return events;
      }
      events.push(e);
    }
    offset = next;
  }
  if (buf.length && buf[buf.length - 1] !== 0x0a) appendFileSync(file, '\n');
  return events;
}

/**
 * Open (or create) the event store in `dataDir`.
 * @param {{dataDir:string}} opts
 * @returns {{
 *   state: ReturnType<typeof initialState>,
 *   append: (type:string, payload:object, actor?:string) => import('../shared/events.js').OutpostEvent,
 *   events: (sinceSeq?:number) => import('../shared/events.js').OutpostEvent[],
 *   subscribe: (fn:(e:object)=>void) => () => void,
 *   close: () => void,
 * }}
 */
export function createStore({ dataDir }) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'events.ndjson');
  const log = replay(file);
  const state = initialState();
  for (const e of log) apply(state, e);

  const fd = openSync(file, 'a');
  const subscribers = new Set();
  let closed = false;
  let lastSync = 0;
  let syncTimer = null;

  function sync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    lastSync = Date.now();
    fsyncSync(fd);
  }

  function scheduleSync() {
    if (syncTimer) return;
    const wait = Math.max(0, FSYNC_INTERVAL_MS - (Date.now() - lastSync));
    if (wait === 0) return sync();
    syncTimer = setTimeout(sync, wait);
    syncTimer.unref();
  }

  function append(type, payload, actor = 'system') {
    if (closed) throw new Error('store is closed');
    const err = validatePayload(type, payload);
    if (err) throw new Error(err);
    if (typeof actor !== 'string' || !actor) throw new Error(`${type}: actor must be a non-empty string`);
    const line = JSON.stringify({ seq: state.seq + 1, ts: new Date().toISOString(), type, actor, payload });
    // Apply the serialized form so live state is exactly what a replay of the file produces.
    const event = JSON.parse(line);
    appendFileSync(fd, `${line}\n`);
    scheduleSync();
    log.push(event);
    apply(state, event);
    for (const fn of [...subscribers]) {
      try {
        fn(event);
      } catch (subErr) {
        console.error(`outpost store: subscriber failed on ${type} #${event.seq}:`, subErr);
      }
    }
    return event;
  }

  function events(sinceSeq = 0) {
    // replay enforces contiguous seqs from 1, so the event with seq N sits at index N-1.
    return log.slice(Math.max(0, Math.floor(Number(sinceSeq) || 0)));
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function close() {
    if (closed) return;
    closed = true;
    sync();
    closeSync(fd);
    subscribers.clear();
  }

  return { state, append, events, subscribe, close };
}
