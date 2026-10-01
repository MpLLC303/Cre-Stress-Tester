#!/usr/bin/env node
// Sidecar entry point: boot the station from the event log, repair anything a crash left in
// flight, and serve the UI on loopback.

import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStation } from './capability.js';
import { loadConfig } from './config.js';
import { createEtsyConnector } from './connectors/etsy.js';
import { createDispatcher, createProviderFor } from './dispatcher.js';
import { createImageProvider } from './images.js';
import { createScheduler } from './scheduler.js';
import { createServer, runtimeMeta } from './server.js';
import { createStore } from './store.js';

const SCRIPTED_BANNER = 'SCRIPTED DEMO — no model calls; set ANTHROPIC_API_KEY for live agents';

function readStation(path) {
  let station;
  try {
    station = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read station layout ${path}: ${err.message}`);
  }
  const shapeOk = station && ['rooms', 'hallways', 'agents'].every((k) => Array.isArray(station[k]));
  const problems = shapeOk ? validateStation(station) : ['the layout needs rooms, hallways and agents arrays'];
  if (problems.length) throw new Error(`invalid station layout ${path}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return station;
}

/** The data dir lock: one sidecar per log, or two writers would interleave seqs and corrupt it. */
export function lockFile(dataDir) {
  return join(dataDir, 'outpost.lock');
}

const heldLocks = new Set(); // lock paths this process holds

function pidAlive(pid) {
  // Our own pid in a lock we do not hold is a previous incarnation's (e.g. pid 1 in a container).
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

/**
 * Take the data dir lock (`outpost.lock`, holding the owner's pid) or throw. A lock left by a
 * process that no longer exists is stale and taken over.
 * @returns {() => void} release
 */
export function acquireDataDirLock(dataDir) {
  const path = lockFile(realpathSync(dataDir)); // one key per directory, however it is spelled
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let pid = NaN;
      try {
        pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
      } catch {
        // vanished or unreadable: retry the create once
      }
      if (heldLocks.has(path) || (Number.isInteger(pid) && pid > 0 && pidAlive(pid))) {
        if (heldLocks.has(path)) pid = process.pid;
        throw new Error(`data dir ${dataDir} is already in use by outpost pid ${pid} (lock ${path}); stop that sidecar first, or delete the lock file if that pid is not an outpost sidecar`);
      }
      try {
        unlinkSync(path); // stale: its process is gone
      } catch {
        // someone else removed it first
      }
      continue;
    }
    try {
      writeSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
    heldLocks.add(path);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      heldLocks.delete(path);
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    };
  }
  throw new Error(`cannot take the data dir lock ${path}`);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

/** Where the Etsy connector keeps its rotated OAuth token pair (never served, never logged). */
export function etsyTokenFile(dataDir) {
  return join(dataDir, 'secrets', 'etsy-token.json');
}

/** Banner line for the Etsy connector: configuration and token lifecycle, never token material. */
function etsyLine(etsy) {
  if (!etsy?.configured) return 'configured: no';
  const t = etsy.tokenStatus?.();
  if (!t) return 'configured: yes';
  const from = { file: 'saved token', env: 'environment', refresh: 'refreshed token' }[t.source] || 'unknown';
  return `configured: yes (token from ${from}; ${t.refreshable ? 'auto-refresh on' : 'no ETSY_REFRESH_TOKEN: access token expires in ~1 h'})`;
}

/** Browsers must use a Host the DNS-rebinding guard accepts, so wildcard binds print loopback. */
function publicUrl(host, port) {
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${shown.includes(':') ? `[${shown}]` : shown}:${port}/`;
}

/**
 * Boot a station: open the log, load the layout (logging station.loaded only when it changed),
 * recover, and start serving, dispatching and scheduling.
 * @param {ReturnType<typeof loadConfig>} config
 * @returns {Promise<{config:object, store:object, dispatcher:object, scheduler:object,
 *   server:import('node:http').Server, meta:object, url:string, recovered:object, stop:() => void}>}
 * @throws {Error} on an unreadable or invalid station layout, or when the port cannot be bound
 */
export async function startStation(config) {
  mkdirSync(config.dataDir, { recursive: true });
  // Everything that can refuse a bad setup runs before the log is opened.
  const station = readStation(config.stationPath);
  // Before anything reads or writes the log: a second sidecar on this dir (even on another port)
  // must stop here, not append recovery events into a log another process is writing.
  const release = acquireDataDirLock(config.dataDir);
  let store = null;
  try {
    // Rotated Etsy tokens persist here (0600) and win over ETSY_ACCESS_TOKEN/ETSY_REFRESH_TOKEN on boot.
    const connectors = { etsy: createEtsyConnector({ ...config.etsy, tokenFile: etsyTokenFile(config.dataDir) }) };
    const imageProvider = createImageProvider(config.image);
    const providerFor = createProviderFor(config);

    store = createStore({ dataDir: config.dataDir });
    if (JSON.stringify(station) !== JSON.stringify(store.state.station)) store.append('station.loaded', { station }, 'system');
    const dispatcher = createDispatcher({ store, config, station, providerFor, imageProvider, connectors });
    const recovered = dispatcher.recover();
    const scheduler = createScheduler({ store, dispatcher });
    const meta = runtimeMeta({ config, imageProvider, connectors });
    const server = createServer({ store, dispatcher, scheduler, config, meta, connectors });

    let port;
    try {
      port = await listen(server, config.port, config.host);
    } catch (err) {
      throw new Error(`cannot listen on ${config.host}:${config.port}: ${err.message}`);
    }
    dispatcher.start();
    scheduler.start();

    let stopped = false;
    const openStore = store;
    /** Stop serving and dispatching, close the log and release the data dir. Idempotent; runs in flight are not awaited. */
    function stop() {
      if (stopped) return;
      stopped = true;
      scheduler.stop();
      dispatcher.stop();
      server.close();
      server.closeAllConnections();
      openStore.close();
      release();
    }
    return { config, store, dispatcher, scheduler, server, meta, connectors, url: publicUrl(config.host, port), recovered, stop };
  } catch (err) {
    try {
      store?.close();
    } finally {
      release();
    }
    throw err;
  }
}

function banner({ config, meta, url, recovered, store, connectors }) {
  const provider = config.provider === 'anthropic'
    ? `${meta.providerLabel}${config.modelOverride ? ` (every agent on ${config.modelOverride})` : ' (models per agent from the station layout)'}`
    : SCRIPTED_BANNER;
  const image = meta.imageProvider ? `${meta.imageProvider.name} (${meta.imageProvider.model})` : 'none (set OUTPOST_IMAGE_PROVIDER=openai and OPENAI_API_KEY)';
  const labels = {
    approvalsExpired: 'approvals expired',
    runsInterrupted: 'runs marked interrupted',
    tasksCompleted: 'tasks closed from runs that finished before the restart',
    tasksRequeued: 'tasks re-queued',
    tasksFailed: 'tasks failed (out of attempts)',
    agentsReset: 'agents reset to idle',
    reviewsCreated: 'missing reviews created',
  };
  const repaired = Object.entries(recovered).filter(([, n]) => n > 0).map(([key, n]) => `${n} ${labels[key]}`);
  return [
    `OUTPOST ${meta.version} · ${store.state.station.name} online`,
    `  URL             ${url}`,
    `  Provider        ${provider}`,
    `  Data dir        ${config.dataDir}`,
    `  Etsy connector  ${etsyLine(connectors?.etsy)}`,
    `  Image provider  ${image}`,
    ...(repaired.length ? [`  Recovered       ${repaired.join(', ')}`] : []),
    '  Ctrl-C to stop.',
  ].join('\n');
}

/** CLI entry: boot from the environment, print the banner, stop cleanly on SIGINT/SIGTERM. */
export async function main(env = process.env) {
  let station;
  try {
    station = await startStation(loadConfig(env));
  } catch (err) {
    console.error(`outpost: ${err.message}`);
    process.exit(1);
  }
  console.log(banner(station));
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\noutpost: ${signal} received, stopping (runs in flight are recovered on next start)`);
    station.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return station;
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false; // no script path (node -e, REPL) or one that does not resolve
  }
}

if (invokedDirectly()) await main();
