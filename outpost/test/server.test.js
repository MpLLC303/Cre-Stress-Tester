import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { writeArtifact } from '../sidecar/artifacts.js';
import { ETSY_SETUP_HINT, createEtsyConnector } from '../sidecar/connectors/etsy.js';
import { createDispatcher, createProviderFor } from '../sidecar/dispatcher.js';
import { createScheduler } from '../sidecar/scheduler.js';
import { createServer, runtimeMeta } from '../sidecar/server.js';
import { createStore } from '../sidecar/store.js';

const STATION = JSON.parse(fs.readFileSync(new URL('../config/station.json', import.meta.url), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-'));
const SECRETS = { etsyKey: 'etsy-key-SECRET-1', etsyShared: 'etsy-shared-SECRET-2', etsyToken: 'etsy-token-SECRET-3', imageKey: 'sk-image-SECRET-4' };
const ARTIFACT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

// ---- fixtures ---------------------------------------------------------------------------

/** A real store, dispatcher (never started, so tasks stay queued) and scheduler behind the server. */
async function start(t, { connectors = { etsy: { configured: false } }, writeImpl } = {}) {
  const dataDir = tmp();
  const store = createStore({ dataDir, ...(writeImpl ? { writeImpl } : {}) });
  store.append('station.loaded', { station: STATION });
  const config = {
    dataDir,
    provider: 'scripted',
    modelOverride: null,
    tickMs: 60_000,
    allowHosts: ['outpost.test'],
    etsy: { apiKey: SECRETS.etsyKey, sharedSecret: SECRETS.etsyShared, accessToken: SECRETS.etsyToken, shopId: null },
    image: { provider: null, model: null, apiKey: SECRETS.imageKey },
  };
  const dispatcher = createDispatcher({ store, config, station: STATION, providerFor: createProviderFor(config), connectors });
  const scheduler = createScheduler({ store, dispatcher });
  const server = createServer({ store, dispatcher, scheduler, config, meta: runtimeMeta({ config, imageProvider: null, connectors }), connectors });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => {
    server.close();
    server.closeAllConnections();
    store.close();
  });
  return { port, store, dataDir, dispatcher };
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const get = (port, p, headers) => request(port, { path: p, headers });
const post = (port, p, body = {}, headers = {}) =>
  request(port, { method: 'POST', path: p, body, headers: { 'x-outpost-client': '1', 'content-type': 'application/json', ...headers } });

/** Open an SSE stream; `frames` fills as they arrive. */
function openStream(port, query, headers = {}) {
  const frames = [];
  let res;
  const ready = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/events${query}`, headers: { host: `127.0.0.1:${port}`, ...headers } }, (r) => {
      res = r;
      let buf = '';
      r.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          if (!frame.startsWith(':')) frames.push(frame); // comments (': open', ': ping') carry no events
          buf = buf.slice(i + 2);
        }
      });
      resolve(r);
    });
    req.on('error', reject);
    req.end();
  });
  return { frames, ready, close: () => res.destroy() };
}

async function waitFor(predicate, label, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---- guards ------------------------------------------------------------------------------

test('Host guard: unknown Host -> 421 (DNS rebinding); loopback names and allowHosts pass', async (t) => {
  const { port } = await start(t);
  const evil = await get(port, '/api/snapshot', { host: `evil.example:${port}` });
  assert.equal(evil.status, 421);
  assert.match(evil.json().error, /DNS-rebinding/);
  assert.equal((await get(port, '/', { host: 'rebind.attacker.test' })).status, 421, 'static files are guarded too');
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, '[::1]', 'outpost.test', `OUTPOST.TEST:${port}`]) {
    assert.equal((await get(port, '/api/snapshot', { host })).status, 200, host);
  }
  // The whole header must parse: nothing may trail a bracketed IPv6 literal but a port.
  for (const host of ['[::1]evil.com', '[::1]anything', '[::1]:abc', '[::1', 'localhost:80:80', 'localhost evil', '127.0.0.1:99999999']) {
    assert.equal((await get(port, '/api/snapshot', { host })).status, 421, host);
  }
});

test('GET /api/* refuses cross-site requests (the work would be done even though the page cannot read it)', async (t) => {
  const { port } = await start(t);
  assert.equal((await get(port, '/api/snapshot', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await get(port, '/api/events?since=0', { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await get(port, '/api/snapshot', { origin: 'http://evil.example' })).status, 403);
  assert.equal((await get(port, '/api/snapshot', { 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await get(port, '/api/snapshot', { 'sec-fetch-site': 'none' })).status, 200, 'typed into the address bar');
  assert.equal((await get(port, '/api/snapshot', { origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await get(port, '/', { 'sec-fetch-site': 'cross-site' })).status, 200, 'the app itself is not an API');
});

test('POST guards: x-outpost-client required, foreign Origin refused, preflights never approved', async (t) => {
  const { port, store } = await start(t);
  const noHeader = await request(port, { method: 'POST', path: '/api/estop', body: { engaged: true }, headers: { 'content-type': 'application/json' } });
  assert.equal(noHeader.status, 403);
  assert.match(noHeader.json().error, /x-outpost-client/);

  const foreign = await post(port, '/api/estop', { engaged: true }, { origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.match(foreign.json().error, /cross-origin/);
  assert.equal((await post(port, '/api/estop', { engaged: true }, { origin: `http://127.0.0.1:${port + 1}` })).status, 403, 'another port is another origin');
  assert.equal((await post(port, '/api/estop', { engaged: true }, { origin: 'null' })).status, 403);
  assert.equal(store.state.estop, false, 'no refused request had an effect');

  assert.equal((await post(port, '/api/estop', { engaged: true }, { origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal(store.state.estop, true);

  const preflight = await request(port, { method: 'OPTIONS', path: '/api/estop', headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
});

test('POST bodies: JSON objects up to 1 MB, errors as JSON', async (t) => {
  const { port } = await start(t);
  const wrongType = await post(port, '/api/estop', '{"engaged":true}', { 'content-type': 'text/plain' });
  assert.equal(wrongType.status, 415);
  assert.equal((await post(port, '/api/estop', '{"engaged":')).status, 400);
  assert.match((await post(port, '/api/estop', [])).json().error, /JSON object/);
  const big = await post(port, '/api/goals', { goal: 'x'.repeat(1024 * 1024) });
  assert.equal(big.status, 413);
  assert.match(big.json().error, /exceeds/);
  const missing = await post(port, '/api/nope');
  assert.equal(missing.status, 404);
  assert.match(missing.headers['content-type'], /^application\/json/);
  assert.equal((await request(port, { method: 'PUT', path: '/api/estop' })).status, 405);
});

// ---- static files ------------------------------------------------------------------------

test('static files: content types, the app CSP, and no path traversal', async (t) => {
  const { port } = await start(t);
  const index = await get(port, '/');
  assert.equal(index.status, 200);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(index.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(index.text, /<canvas id="world"/);
  assert.equal((await get(port, '/frontend/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await get(port, '/frontend/style.css')).headers['content-type'], 'text/css; charset=utf-8');
  const projector = await get(port, '/shared/projector.js');
  assert.equal(projector.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(projector.headers['x-content-type-options'], 'nosniff');
  assert.equal(projector.text, fs.readFileSync(new URL('../shared/projector.js', import.meta.url), 'utf8'));

  for (const p of ['/frontend/..%2fpackage.json', '/shared/..%2f..%2fpackage.json', '/shared/%2e%2e%2fsidecar%2fconfig.js', '/frontend/..%5c..%5cpackage.json']) {
    const res = await get(port, p);
    assert.ok([403, 404].includes(res.status), `${p} -> ${res.status}`);
    assert.doesNotMatch(res.text, /"dependencies"|loadConfig/, p);
  }
  assert.equal((await get(port, '/frontend/..%2fpackage.json')).status, 403);
  for (const p of ['/frontend/../package.json', '/frontend/%2e%2e/sidecar/config.js', '/sidecar/config.js', '/package.json', '/frontend/', '/frontend/missing.js']) {
    const res = await get(port, p);
    assert.equal(res.status, 404, p);
    assert.doesNotMatch(res.text, /"dependencies"|loadConfig/, p);
  }
  assert.equal((await get(port, '/frontend/%E0%A4%A')).status, 400, 'malformed escapes');
  assert.equal((await get(port, '/frontend/app.js%00.css')).status, 400);
});

// ---- snapshot and events -----------------------------------------------------------------

test('snapshot: the projection plus runtime meta, uncached, with no secrets', async (t) => {
  const { port, store } = await start(t);
  const res = await get(port, '/api/snapshot');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const snap = res.json();
  assert.equal(snap.seq, store.state.seq);
  assert.equal(snap.state.station.name, 'OUTPOST-1');
  assert.deepEqual(snap.meta, {
    provider: 'scripted',
    providerLabel: 'SCRIPTED DEMO · no model calls',
    modelOverride: null,
    imageProvider: null,
    connectors: { etsy: { configured: false, setup: ETSY_SETUP_HINT } },
    version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    logId: store.logId(),
    storeFailed: null,
  });
  assert.match(snap.meta.logId, /^[0-9a-f]{16}$/);
  for (const secret of Object.values(SECRETS)) assert.ok(!res.text.includes(secret), 'secrets never leave the sidecar');

  // A key being set proves nothing: the label says so, and the UI derives LIVE from run.step events.
  const live = runtimeMeta({ config: { provider: 'anthropic', modelOverride: 'claude-haiku-4-5' }, imageProvider: { name: 'openai', model: 'gpt-image-2', generate() {} }, connectors: { etsy: { configured: true } } });
  assert.equal(live.providerLabel, 'Anthropic API · key set');
  assert.equal(live.modelOverride, 'claude-haiku-4-5', 'OUTPOST_MODEL is surfaced: every agent runs on it');
  assert.deepEqual(live.imageProvider, { name: 'openai', model: 'gpt-image-2' });
  assert.deepEqual(live.connectors, { etsy: { configured: true, setup: null } });
});

test('SSE: replays seq > since, then streams live frames; the subscription ends with the connection', async (t) => {
  const { port, store } = await start(t);
  store.append('log', { level: 'info', message: 'one' });
  store.append('log', { level: 'info', message: 'two' });
  let subscribers = 0;
  const subscribe = store.subscribe;
  store.subscribe = (fn) => {
    subscribers += 1;
    const off = subscribe(fn);
    return () => {
      subscribers -= 1;
      off();
    };
  };

  const since = store.state.seq - 1;
  const stream = openStream(port, `?since=${since}`);
  const res = await stream.ready;
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  await waitFor(() => stream.frames.length === 1, 'the replay');
  const last = store.events(since)[0];
  assert.equal(stream.frames[0], `id: ${last.seq}\nevent: outpost\ndata: ${JSON.stringify(last)}`);

  const live = store.append('log', { level: 'info', message: 'three' });
  await waitFor(() => stream.frames.length === 2, 'the live event');
  assert.equal(stream.frames[1], `id: ${live.seq}\nevent: outpost\ndata: ${JSON.stringify(live)}`);
  assert.equal(subscribers, 1);
  stream.close();
  await waitFor(() => subscribers === 0, 'the subscription to be dropped on close');

  const resumed = openStream(port, '', { 'last-event-id': String(live.seq - 1) });
  await resumed.ready;
  await waitFor(() => resumed.frames.length === 1, 'resume from Last-Event-ID');
  assert.match(resumed.frames[0], new RegExp(`^id: ${live.seq}\n`));
  resumed.close();
  assert.equal((await get(port, '/api/events?since=-1')).status, 400);
  assert.equal((await get(port, '/api/events?since=abc')).status, 400);
});

test('SSE: a long log is replayed in batches, completely and in order, with live events after it', async (t) => {
  const { port, store } = await start(t);
  for (let i = 0; i < 1234; i += 1) store.append('log', { level: 'info', message: `m${i}` });
  const stream = openStream(port, '?since=0');
  await stream.ready;
  await new Promise((r) => setImmediate(r));
  const live = store.append('log', { level: 'info', message: 'live' }); // may land between batches
  await waitFor(() => stream.frames.length === live.seq, 'every event once');
  const seqs = stream.frames.map((f) => Number(f.match(/^id: (\d+)/)[1]));
  assert.deepEqual(seqs, Array.from({ length: live.seq }, (_, i) => i + 1), 'no gap, no duplicate');
  stream.close();
});

test('SSE: concurrent streams are capped', async (t) => {
  const { port } = await start(t);
  const streams = [];
  for (let i = 0; i < 32; i += 1) {
    const s = openStream(port, '?since=0');
    await s.ready;
    streams.push(s);
  }
  const over = await get(port, '/api/events?since=0');
  assert.equal(over.status, 503);
  assert.match(over.json().error, /too many open event streams/);
  streams.pop().close();
  await new Promise((r) => setTimeout(r, 50));
  const again = openStream(port, '?since=0');
  assert.equal((await again.ready).statusCode, 200, 'a closed stream frees its slot');
  again.close();
  for (const s of streams) s.close();
});

test('a failed log write drops every stream, the snapshot reports it, and commands get 503 (RT-2)', async (t) => {
  const io = { fail: false };
  const writeImpl = (fd, data) => {
    if (io.fail) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    fs.appendFileSync(fd, data);
  };
  const { port, store } = await start(t, { writeImpl });
  const stream = openStream(port, `?since=${store.state.seq}`);
  const res = await stream.ready;
  const closed = new Promise((r) => res.on('close', r));
  io.fail = true;
  assert.throws(() => store.append('log', { level: 'info', message: 'x' }), /no space/);
  await closed; // the client reconnects and refetches the snapshot
  const snap = (await get(port, '/api/snapshot')).json();
  assert.equal(snap.meta.storeFailed, 'ENOSPC: no space left on device');
  const refused = await post(port, '/api/goals', { goal: 'anything' });
  assert.equal(refused.status, 503);
  assert.match(refused.json().error, /read-only/);
});

test('SSE backpressure: a client that stops reading is dropped, not buffered without bound', async (t) => {
  const { port, store } = await start(t);
  let subscribers = 0;
  const subscribe = store.subscribe;
  store.subscribe = (fn) => {
    subscribers += 1;
    const off = subscribe(fn);
    return () => {
      subscribers -= 1;
      off();
    };
  };
  const stream = openStream(port, `?since=${store.state.seq}`);
  const res = await stream.ready;
  res.pause(); // stop reading: the socket fills and the server's writes start returning false
  const filler = 'x'.repeat(100 * 1024);
  for (let i = 0; i < 200 && subscribers > 0; i += 1) {
    store.append('log', { level: 'info', message: `${i} ${filler}` });
    await new Promise((r) => setImmediate(r));
  }
  await waitFor(() => subscribers === 0, 'the stalled client to be dropped');
  assert.equal((await get(port, '/api/snapshot')).status, 200, 'the server keeps serving');
  stream.close();
});

// ---- artifacts ---------------------------------------------------------------------------

test('artifacts: meta, verified bytes under a locked-down CSP, and integrity failures refused', async (t) => {
  const { port, store, dataDir } = await start(t);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  const art = writeArtifact({ store, dataDir }, { agentId: 'pixel', kind: 'svg', title: 'Square', content: svg });

  const meta = await get(port, `/api/artifacts/${art.artifactId}`);
  assert.equal(meta.status, 200);
  assert.equal(meta.json().sha256, art.sha256);
  const content = await get(port, `/api/artifacts/${art.artifactId}/content`);
  assert.equal(content.status, 200);
  assert.equal(content.text, svg);
  assert.equal(content.headers['content-type'], 'image/svg+xml');
  assert.equal(content.headers['x-content-type-options'], 'nosniff');
  assert.equal(content.headers['content-security-policy'], ARTIFACT_CSP);

  assert.equal((await get(port, '/api/artifacts/art_missing/content')).status, 404);
  assert.equal((await get(port, '/api/artifacts/__proto__')).status, 404);
  fs.writeFileSync(path.join(dataDir, art.path), svg.replace('rect', 'circle'));
  const tampered = await get(port, `/api/artifacts/${art.artifactId}/content`);
  assert.equal(tampered.status, 500);
  assert.match(tampered.json().error, /integrity check/);
});

// ---- operator commands -------------------------------------------------------------------

test('goals, tasks and cancellation', async (t) => {
  const { port, store } = await start(t);
  const goal = await post(port, '/api/goals', { goal: 'Find a mug niche\nwith gardening themes' });
  assert.equal(goal.status, 200);
  const task = store.state.tasks[goal.json().taskId];
  assert.deepEqual(
    { assignee: task.assignee, title: task.title, brief: task.brief, createdBy: task.createdBy },
    { assignee: 'orion', title: 'Goal: Find a mug niche', brief: 'Find a mug niche\nwith gardening themes', createdBy: 'operator' },
  );
  assert.equal((await post(port, '/api/goals', { goal: '   ' })).status, 400);

  const created = await post(port, '/api/tasks', { assignee: 'tally', title: 'Books', brief: 'Reconcile.' });
  assert.equal(created.status, 200);
  const { taskId } = created.json();
  assert.equal(store.state.tasks[taskId].assignee, 'tally');
  assert.match((await post(port, '/api/tasks', { assignee: 'ghost', title: 't', brief: 'b' })).json().error, /unknown agent "ghost"/);
  assert.equal((await post(port, '/api/tasks', { assignee: 'tally', title: 't', brief: 'b', inputs: ['art_none'] })).status, 400);
  assert.equal((await post(port, '/api/tasks', { assignee: 'tally', title: 't', brief: 'b', inputs: 'art_x' })).status, 400);

  assert.equal((await post(port, `/api/tasks/${taskId}/cancel`)).status, 200);
  assert.equal(store.state.tasks[taskId].status, 'cancelled');
  assert.equal((await post(port, `/api/tasks/${taskId}/cancel`)).status, 409);
  assert.equal((await post(port, '/api/tasks/task_none/cancel')).status, 404);
});

test('recipes, approvals and E-STOP', async (t) => {
  const { port, store } = await start(t);
  const recipe = await post(port, '/api/recipes/thumbnail_order', { params: { order_ref: 'ORD-7' } });
  assert.equal(recipe.status, 200);
  const { recipeRunId, taskIds } = recipe.json();
  assert.equal(taskIds.length, 3);
  assert.deepEqual(store.state.recipes[recipeRunId].taskIds, taskIds);
  assert.match(store.state.tasks[taskIds[0]].brief, /Order ref: "ORD-7"/);
  assert.equal((await post(port, '/api/recipes/unknown')).status, 404);
  assert.equal((await post(port, '/api/recipes/__proto__')).status, 404);
  assert.match((await post(port, '/api/recipes/pod_listing', { params: { colour: 'red' } })).json().error, /no param "colour"/);

  store.append('approval.requested', { approvalId: 'apr_orphan', runId: 'run_x', agentId: 'quill', taskId: taskIds[0], tool: 'publish_listing', summary: 's', input: '{}' }, 'quill');
  assert.equal((await post(port, '/api/approvals/apr_orphan', { decision: 'maybe' })).status, 400);
  assert.equal((await post(port, '/api/approvals/apr_none', { decision: 'granted' })).status, 404);
  const orphan = await post(port, '/api/approvals/apr_orphan', { decision: 'granted', note: '' });
  assert.equal(orphan.status, 409, 'no run is waiting on it, so granting it would change nothing');
  assert.match(orphan.json().error, /not held by a running task/);
  assert.equal(store.state.approvals.apr_orphan.status, 'pending');

  assert.equal((await post(port, '/api/estop', { engaged: 'yes' })).status, 400);
  assert.deepEqual((await post(port, '/api/estop', { engaged: true })).json(), { engaged: true });
  assert.deepEqual((await post(port, '/api/estop', { engaged: false })).json(), { engaged: false });
  assert.deepEqual(store.events().filter((e) => e.type === 'estop').map((e) => [e.actor, e.payload.engaged]), [['operator', true], ['operator', false]]);
});

test('manual ledger entries carry manual provenance and are validated', async (t) => {
  const { port, store } = await start(t);
  const res = await post(port, '/api/ledger/manual', { kind: 'revenue', amount_usd: 12.5, stream: 'fiverr', memo: 'Order 44', occurred_at: '2026-09-30T10:00:00Z' });
  assert.equal(res.status, 200);
  const event = store.events().find((e) => e.type === 'ledger.entry');
  assert.equal(event.actor, 'operator');
  assert.deepEqual(
    { ...event.payload, entryId: undefined },
    { entryId: undefined, kind: 'revenue', amountCents: 1250, currency: 'USD', stream: 'fiverr', provenance: 'manual', source: { note: 'entered by the operator' }, occurredAt: '2026-09-30T10:00:00.000Z', memo: 'Order 44' },
  );
  assert.equal(store.state.ledger.totals.operatorRevenueCents, 1250);
  assert.equal(store.state.ledger.totals.verifiedRevenueCents, 0);

  const bad = [
    { kind: 'gift', amount_usd: 1, stream: 's' },
    { kind: 'fee', amount_usd: -3, stream: 's' },
    { kind: 'fee', amount_usd: 0.001, stream: 's' },
    { kind: 'fee', amount_usd: '3', stream: 's' },
    { kind: 'fee', amount_usd: 3, stream: '' },
    { kind: 'fee', amount_usd: 3, stream: 's', currency: 'usd' },
    { kind: 'fee', amount_usd: 3, stream: 's', occurred_at: 'yesterday' },
  ];
  for (const body of bad) assert.equal((await post(port, '/api/ledger/manual', body)).status, 400, JSON.stringify(body));
  // Counted totals are USD and nothing converts: a EUR amount would be shown and summed as dollars.
  const eur = await post(port, '/api/ledger/manual', { kind: 'revenue', amount_usd: 50, currency: 'EUR', stream: 'fiverr' });
  assert.equal(eur.status, 400);
  assert.match(eur.json().error, /only USD is supported until per-currency totals exist/);
  assert.equal((await post(port, '/api/ledger/manual', { kind: 'fee', amount_usd: 1, currency: 'USD', stream: 'fiverr' })).status, 200);
  assert.equal(store.state.ledger.entryOrder.length, 2);
  assert.equal(store.state.ledger.totals.operatorRevenueCents, 1250);
});

test('connector sync: 501 when not configured, verified entries when it is', async (t) => {
  const off = await start(t);
  const notConfigured = await post(off.port, '/api/connectors/etsy/sync');
  assert.equal(notConfigured.status, 501);
  assert.match(notConfigured.json().error, /ETSY_API_KEY, ETSY_SHARED_SECRET, ETSY_SHOP_ID and ETSY_ACCESS_TOKEN/);
  assert.equal((await post(off.port, '/api/connectors/shopify/sync')).status, 404);

  const usd = (cents) => ({ amount: cents, divisor: 100, currency_code: 'USD' });
  const receipt = { receipt_id: 9, is_paid: true, create_timestamp: 1_790_000_000, total_price: usd(2000), total_shipping_cost: usd(500), discount_amt: usd(0), refunds: [] };
  const fetchImpl = async () => new Response(JSON.stringify({ count: 1, results: [receipt] }), { status: 200 });
  const etsy = createEtsyConnector({ apiKey: 'k', sharedSecret: 's', accessToken: 't', shopId: '1', fetchImpl });
  const on = await start(t, { connectors: { etsy } });
  const synced = await post(on.port, '/api/connectors/etsy/sync');
  assert.equal(synced.status, 200);
  assert.deepEqual(synced.json(), { fetched: 1, newEntries: 1, receipts: { fetched: 1, newEntries: 1 }, fees: { fetched: 1, newEntries: 0 } });
  assert.equal(on.store.state.ledger.totals.verifiedRevenueCents, 2500);
  assert.deepEqual((await post(on.port, '/api/connectors/etsy/sync')).json(), { fetched: 1, newEntries: 0, receipts: { fetched: 1, newEntries: 0 }, fees: { fetched: 1, newEntries: 0 } }, 'dedup by externalId');
});

test('schedules are validated and logged', async (t) => {
  const { port, store } = await start(t);
  const res = await post(port, '/api/schedules', { spec: 'every 6h', template: { recipe: 'ledger_report' } });
  assert.equal(res.status, 200);
  assert.deepEqual(store.state.schedules[res.json().scheduleId].template, { recipe: 'ledger_report' });
  assert.equal((await post(port, '/api/schedules', { spec: 'sometimes', template: { recipe: 'ledger_report' } })).status, 400);
  assert.equal((await post(port, '/api/schedules', { spec: 'every 1h', template: { recipe: 'nope' } })).status, 400);
});
