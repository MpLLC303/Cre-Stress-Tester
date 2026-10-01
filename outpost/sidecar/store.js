// Event store: the append-only NDJSON log and the live projection built from it.
//
// Every state change goes through append(): validate -> persist -> apply -> notify. On open the
// log is replayed through the same projector, so the in-memory state is always a fold of the
// file on disk.

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, truncateSync } from 'node:fs';
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
 *
 * Fail-stop: if a write fails (ENOSPC, EIO, ...), the partial line is cut off again and the store
 * refuses every later append, so the file never holds a fragment that a later event would merge
 * into, and live state never runs ahead of the disk. health() reports it; a restart recovers.
 * @param {{dataDir:string, writeImpl?:(fd:number, data:string) => void}} opts writeImpl is a test seam
 *   (defaults to appendFileSync)
 * @returns {{
 *   state: ReturnType<typeof initialState>,
 *   append: (type:string, payload:object, actor?:string) => import('../shared/events.js').OutpostEvent,
 *   events: (sinceSeq?:number, limit?:number) => import('../shared/events.js').OutpostEvent[],
 *   subscribe: (fn:(e:object)=>void) => () => void,
 *   onFailure: (fn:(message:string)=>void) => () => void,
 *   health: () => {failed:string|null},
 *   logId: () => string|null,
 *   close: () => void,
 * }}
 */
export function createStore({ dataDir, writeImpl = appendFileSync }) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'events.ndjson');
  const log = replay(file);
  const state = initialState();
  for (const e of log) apply(state, e);

  const fd = openSync(file, 'a');
  const subscribers = new Set();
  const failureSubs = new Set();
  let closed = false;
  let failed = null; // message of the write failure that made the store read-only
  let logIdCache = null;
  let lastSync = 0;
  let syncTimer = null;

  function sync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    lastSync = Date.now();
    try {
      fsyncSync(fd);
    } catch (err) {
      // Runs from a timer too: a failing disk turns the store read-only instead of crashing.
      if (!failed) fail(err);
    }
  }

  function scheduleSync() {
    if (syncTimer) return;
    const wait = Math.max(0, FSYNC_INTERVAL_MS - (Date.now() - lastSync));
    if (wait === 0) return sync();
    syncTimer = setTimeout(sync, wait);
    syncTimer.unref();
  }

  function fail(err) {
    failed = err.code && !String(err.message).startsWith(err.code) ? `${err.code}: ${err.message}` : String(err.message);
    console.error(`outpost store: write to ${file} failed (${failed}); the store is read-only until restart`);
    for (const fn of [...failureSubs]) {
      try {
        fn(failed);
      } catch (subErr) {
        console.error('outpost store: failure subscriber failed:', subErr);
      }
    }
  }

  function append(type, payload, actor = 'system') {
    if (closed) throw new Error('store is closed');
    if (failed) throw new Error(`store is read-only after a write failure: ${failed}`);
    const err = validatePayload(type, payload);
    if (err) throw new Error(err);
    if (typeof actor !== 'string' || !actor) throw new Error(`${type}: actor must be a non-empty string`);
    const line = JSON.stringify({ seq: state.seq + 1, ts: new Date().toISOString(), type, actor, payload });
    // Apply the serialized form so live state is exactly what a replay of the file produces.
    const event = JSON.parse(line);
    const before = fstatSync(fd).size;
    try {
      writeImpl(fd, `${line}\n`);
    } catch (writeErr) {
      // A short write leaves a fragment with no newline: cut it off so the file ends on a whole
      // event, then stop accepting appends (nothing was applied or announced).
      try {
        ftruncateSync(fd, before);
        fsyncSync(fd);
      } catch {
        // the disk is failing; replay drops a torn final line anyway
      }
      fail(writeErr);
      throw writeErr;
    }
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

  /** Events with seq > sinceSeq, at most `limit` of them when given (oldest first). */
  function events(sinceSeq = 0, limit = undefined) {
    // replay enforces contiguous seqs from 1, so the event with seq N sits at index N-1.
    const start = Math.max(0, Math.floor(Number(sinceSeq) || 0));
    return log.slice(start, limit ? start + limit : undefined);
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  /** fn(message) once, when a write fails and the store turns read-only. */
  function onFailure(fn) {
    failureSubs.add(fn);
    return () => failureSubs.delete(fn);
  }

  const health = () => ({ failed });

  /**
   * Identity of this log: a hash of its first event, so two data dirs (or a reset log) never share
   * it even when their seqs overlap. Null while the log is empty.
   */
  function logId() {
    if (!logIdCache && log.length) logIdCache = createHash('sha256').update(JSON.stringify(log[0])).digest('hex').slice(0, 16);
    return logIdCache;
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      sync();
    } catch (err) {
      if (!failed) throw err;
    }
    closeSync(fd);
    subscribers.clear();
    failureSubs.clear();
  }

  return { state, append, events, subscribe, onFailure, health, logId, close };
}
