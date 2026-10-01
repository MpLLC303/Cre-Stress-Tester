#!/usr/bin/env node
// Sidecar entry point: boot the station from the event log, repair anything a crash left in
// flight, and serve the UI on loopback.

import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
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

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
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
  const station = readStation(config.stationPath);
  const store = createStore({ dataDir: config.dataDir });
  if (JSON.stringify(station) !== JSON.stringify(store.state.station)) store.append('station.loaded', { station }, 'system');

  const connectors = { etsy: createEtsyConnector(config.etsy) };
  const imageProvider = createImageProvider(config.image);
  const dispatcher = createDispatcher({ store, config, station, providerFor: createProviderFor(config), imageProvider, connectors });
  const recovered = dispatcher.recover();
  const scheduler = createScheduler({ store, dispatcher });
  const meta = runtimeMeta({ config, imageProvider, connectors });
  const server = createServer({ store, dispatcher, scheduler, config, meta, connectors });

  let port;
  try {
    port = await listen(server, config.port, config.host);
  } catch (err) {
    store.close();
    throw new Error(`cannot listen on ${config.host}:${config.port}: ${err.message}`);
  }
  dispatcher.start();
  scheduler.start();

  function stop() {
    scheduler.stop();
    dispatcher.stop();
    server.close();
    server.closeAllConnections();
    store.close();
  }
  return { config, store, dispatcher, scheduler, server, meta, url: publicUrl(config.host, port), recovered, stop };
}

function banner({ config, meta, url, recovered, store }) {
  const provider = config.provider === 'anthropic'
    ? `${meta.providerLabel}${config.modelOverride ? ` (every agent on ${config.modelOverride})` : ' (models per agent from the station layout)'}`
    : SCRIPTED_BANNER;
  const image = meta.imageProvider ? `${meta.imageProvider.name} (${meta.imageProvider.model})` : 'none (set OUTPOST_IMAGE_PROVIDER=openai and OPENAI_API_KEY)';
  const repaired = Object.entries(recovered).filter(([, n]) => n > 0).map(([what, n]) => `${what} ${n}`);
  return [
    `OUTPOST ${meta.version} · ${store.state.station.name} online`,
    `  URL             ${url}`,
    `  Provider        ${provider}`,
    `  Data dir        ${config.dataDir}`,
    `  Etsy connector  configured: ${meta.connectors.etsy.configured ? 'yes' : 'no'}`,
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
