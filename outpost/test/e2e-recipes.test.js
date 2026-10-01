// End to end: the real sidecar boot path (sidecar/index.js startStation), the real HTTP server,
// dispatcher, loop, tools and scripted provider, driven only through the HTTP API and the SSE
// stream the UI uses. Nothing here touches the network beyond loopback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { route } from '../sidecar/capability.js';
import { loadConfig } from '../sidecar/config.js';
import { createEtsyConnector } from '../sidecar/connectors/etsy.js';
import { createDispatcher, createProviderFor } from '../sidecar/dispatcher.js';
import { lockFile, startStation } from '../sidecar/index.js';
import { SCRIPTED_NOTICE } from '../sidecar/providers/scripts.js';
import { createStore } from '../sidecar/store.js';
import { sanitizeSvg } from '../sidecar/svg.js';

const STATION = JSON.parse(fs.readFileSync(new URL('../config/station.json', import.meta.url), 'utf8'));
const HALLWAYS = new Set(STATION.hallways.map((h) => h.id));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-'));

function configFor(dataDir) {
  return loadConfig({ OUTPOST_PROVIDER: 'scripted', OUTPOST_DATA: dataDir, PORT: '0', HOST: '127.0.0.1', OUTPOST_TICK_MS: '50' });
}

async function boot(t, dataDir = tmp()) {
  const station = await startStation(configFor(dataDir));
  t.after(station.stop);
  return { ...station, base: station.url.replace(/\/$/, ''), dataDir };
}

/** The UI's view of the log: GET /api/events?since=N, parsed frame by frame. */
function eventStream(base, since = 0) {
  const controller = new AbortController();
  const events = [];
  let wake = () => {};
  (async () => {
    const res = await fetch(`${base}/api/events?since=${since}`, { signal: controller.signal });
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const data = buf.slice(0, i).split('\n').find((line) => line.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (data) {
          events.push(JSON.parse(data.slice(6)));
          wake();
        }
      }
    }
  })().catch(() => {}); // the stream ends when the test closes it or stops the server

  return {
    events,
    async waitFor(predicate, label, ms = 20_000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = events.find(predicate);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => {
          wake = resolve;
          setTimeout(resolve, 50);
        });
      }
    },
    close: () => controller.abort(),
  };
}

async function postJson(base, p, body = {}) {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'x-outpost-client': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  assert.equal(res.status, 200, `${p}: ${JSON.stringify(json)}`);
  return json;
}

const snapshot = async (base) => (await fetch(`${base}/api/snapshot`)).json();

/** Wait until the review of `parentTaskId` (the recipe's last task) has finished. */
async function waitForReview(stream, parentTaskId) {
  const review = await stream.waitFor((e) => e.type === 'task.created' && e.payload.kind === 'review' && e.payload.parentTaskId === parentTaskId, 'the closing review task');
  await stream.waitFor((e) => e.type === 'task.status' && e.payload.taskId === review.payload.taskId && e.payload.status === 'done', 'the closing review to finish');
  return review.payload.taskId;
}

const artifactsOf = (state, kind) => state.artifactOrder.map((id) => state.artifacts[id]).filter((a) => a.kind === kind);
const fileOf = (dataDir, meta) => fs.readFileSync(path.join(dataDir, meta.path));

/** The honesty checks every scripted run must pass. */
function assertHonest(state, stream, dataDir) {
  const seqs = stream.events.map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'the SSE stream delivered the whole log, in order, without gaps');
  const runs = stream.events.filter((e) => e.type === 'run.started');
  assert.ok(runs.length > 0);
  for (const r of runs) assert.equal(r.payload.provider, 'scripted', 'every run is labelled scripted');
  for (const [k, v] of Object.entries(state.ledger.totals)) assert.equal(v, 0, `ledger ${k} is zero: nothing fabricated`);
  assert.equal(state.ledger.entryOrder.length, 0);
  assert.equal(state.spend.totalUsd, 0, 'scripted runs cost nothing');
  for (const id of state.artifactOrder) {
    const meta = state.artifacts[id];
    const bytes = fileOf(dataDir, meta);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.sha256, `${meta.kind} ${id} on disk matches its logged sha256`);
    assert.ok(bytes.toString('utf8').includes(SCRIPTED_NOTICE), `${meta.kind} ${id} says it is scripted demo content`);
  }
}

function assertHandoffsFollowHallways(state, expected) {
  const hops = state.handoffs.map((h) => [h.fromAgent, h.toAgent, h.route.join('>')]);
  assert.deepEqual(hops, expected);
  for (const h of state.handoffs) {
    assert.ok(h.route.every((id) => HALLWAYS.has(id)), `route ${h.route} uses real hallway ids`);
    assert.deepEqual(h.route, route(STATION, h.fromRoom, h.toRoom), 'the shortest lane between the rooms');
    assert.ok(state.tasks[h.taskId], 'every packet is addressed to a real task');
  }
}

test('pod_listing over HTTP: research, design, listing, review, operator-granted dry-run publish', { timeout: 60_000 }, async (t) => {
  const station = await boot(t);
  const stream = eventStream(station.base);
  t.after(stream.close);
  const { recipeRunId, taskIds } = await postJson(station.base, '/api/recipes/pod_listing', {});
  assert.equal(taskIds.length, 4);

  const approval = await stream.waitFor((e) => e.type === 'approval.requested', 'the publish approval');
  assert.deepEqual([approval.payload.tool, approval.payload.agentId], ['publish_listing', 'quill']);
  assert.ok(!stream.events.some((e) => e.type === 'artifact.created' && e.payload.kind === 'publish_receipt'), 'nothing is published before the operator decides');
  await postJson(station.base, `/api/approvals/${approval.payload.approvalId}`, { decision: 'granted', note: 'e2e grant' });
  const reviewId = await waitForReview(stream, taskIds[3]);

  const { state } = await snapshot(station.base);
  assert.equal(state.recipes[recipeRunId].recipe, 'pod_listing');
  assert.ok(Object.values(state.tasks).every((task) => task.status === 'done'), 'every task finished');
  assert.equal(state.approvals[approval.payload.approvalId].status, 'granted');

  const [svg] = artifactsOf(state, 'svg');
  const svgText = fileOf(station.dataDir, svg).toString('utf8');
  assert.equal(sanitizeSvg(svgText).ok, true, 'the stored design passes the sanitizer');
  assert.equal(createHash('sha256').update(svgText).digest('hex'), svg.sha256);
  const served = await fetch(`${station.base}/api/artifacts/${svg.artifactId}/content`);
  assert.equal(served.headers.get('content-type'), 'image/svg+xml');
  assert.equal(await served.text(), svgText);

  const [draftMeta] = artifactsOf(state, 'listing_draft');
  const draft = JSON.parse(fileOf(station.dataDir, draftMeta));
  assert.ok(draft.tags.length >= 1 && draft.tags.length <= 13, `${draft.tags.length} tags`);
  assert.deepEqual(draft.artifact_ids, [svg.artifactId]);

  const [receiptMeta] = artifactsOf(state, 'publish_receipt');
  const receipt = JSON.parse(fileOf(station.dataDir, receiptMeta));
  assert.equal(receipt.mode, 'dry_run');
  assert.match(receipt.note, /Nothing was sent/);
  assert.match(state.tasks[reviewId].summary, /DRY RUN/);
  assert.deepEqual(state.tasks[reviewId].inputs, [receiptMeta.artifactId], 'the review receives what the delegated task produced');

  assertHandoffsFollowHallways(state, [
    ['nova', 'pixel', 'h-research-production'],
    ['nova', 'quill', 'h-research-production'],
    ['quill', 'orion', 'h-bridge-production'],
    ['orion', 'quill', 'h-bridge-production'],
    ['quill', 'orion', 'h-bridge-production'],
  ]);
  assertHonest(state, stream, station.dataDir);
});

test('thumbnail_order over HTTP: a denied delivery sends nothing and says so', { timeout: 60_000 }, async (t) => {
  const station = await boot(t);
  const stream = eventStream(station.base);
  t.after(stream.close);
  const { taskIds } = await postJson(station.base, '/api/recipes/thumbnail_order', { params: { order_ref: 'E2E-42' } });

  const approval = await stream.waitFor((e) => e.type === 'approval.requested', 'the delivery approval');
  assert.deepEqual([approval.payload.tool, approval.payload.agentId], ['deliver_order', 'flux']);
  await postJson(station.base, `/api/approvals/${approval.payload.approvalId}`, { decision: 'denied', note: 'client cancelled the order' });
  const reviewId = await waitForReview(stream, taskIds[2]);

  const { state } = await snapshot(station.base);
  assert.equal(state.approvals[approval.payload.approvalId].status, 'denied');
  assert.equal(artifactsOf(state, 'delivery').length, 0, 'no delivery artifact');
  assert.equal(artifactsOf(state, 'package').length, 1);
  assert.equal(artifactsOf(state, 'svg').length, 3);
  const deliverTask = state.tasks[approval.payload.taskId];
  assert.equal(deliverTask.status, 'done');
  assert.match(deliverTask.summary, /operator denied the delivery \(client cancelled the order\)/i);
  assert.deepEqual(deliverTask.outputs, []);
  assert.ok(stream.events.some((e) => e.type === 'tool.denied' && e.payload.tool === 'deliver_order'));
  assert.deepEqual(state.tasks[reviewId].inputs, []);
  assert.match(state.tasks[reviewId].summary, /Nothing to review/);
  assert.equal(stream.events.filter((e) => e.type === 'approval.requested').length, 1, 'the denial is not retried');

  assertHandoffsFollowHallways(state, [
    ['vega', 'flux', 'h-research-bridge>h-bridge-output'],
    ['flux', 'orion', 'h-bridge-output'],
    ['orion', 'flux', 'h-bridge-output'],
    ['flux', 'orion', 'h-bridge-output'],
  ]);
  assertHonest(state, stream, station.dataDir);
});

test('restart mid-approval: the request expires, the run is interrupted, the task is re-queued and resumes', { timeout: 60_000 }, async (t) => {
  const dataDir = tmp();
  const first = await boot(t, dataDir);
  const stream = eventStream(first.base);
  await postJson(first.base, '/api/recipes/thumbnail_order', {});
  const approval = await stream.waitFor((e) => e.type === 'approval.requested', 'the delivery approval');
  const { approvalId, runId, taskId } = approval.payload;

  // Kill: stop serving and dispatching and close the log without answering the approval.
  stream.close();
  first.stop();

  const config = configFor(dataDir);
  const store = createStore({ dataDir });
  t.after(() => store.close());
  assert.equal(store.state.approvals[approvalId].status, 'pending', 'the log still shows the request in flight');
  assert.equal(store.state.runs[runId].outcome, null);
  const dispatcher = createDispatcher({
    store,
    config,
    station: store.state.station,
    providerFor: createProviderFor(config),
    connectors: { etsy: createEtsyConnector(config.etsy) },
  });
  t.after(() => dispatcher.stop());

  assert.deepEqual(dispatcher.recover(), { approvalsExpired: 1, runsInterrupted: 1, tasksRequeued: 1, tasksFailed: 0, agentsReset: 1, reviewsCreated: 0 });
  assert.equal(store.state.approvals[approvalId].status, 'expired');
  assert.equal(store.state.runs[runId].outcome, 'interrupted');
  assert.equal(store.state.tasks[taskId].status, 'queued');
  assert.match(store.state.tasks[taskId].reason, /interrupted by a sidecar restart; re-queued \(attempt 2 of 2\)/);
  assert.equal(store.state.agents.flux.status, 'idle');
  assert.equal(dispatcher.resolveApproval(approvalId, 'granted'), false, 'an expired request cannot be granted');

  const seenBefore = store.state.seq;
  dispatcher.start();
  const fresh = await new Promise((resolve) => {
    const off = store.subscribe((e) => {
      if (e.type === 'approval.requested') {
        off();
        resolve(e.payload);
      }
    });
  });
  assert.equal(fresh.taskId, taskId, 'the re-queued task runs again and asks again');
  assert.notEqual(fresh.approvalId, approvalId);
  assert.ok(dispatcher.resolveApproval(fresh.approvalId, 'granted', 'after restart'));
  await new Promise((resolve) => {
    const check = () => store.state.tasks[taskId].status === 'done' && resolve();
    store.subscribe(check);
    check();
  });
  const delivered = store.state.tasks[taskId].outputs.map((id) => store.state.artifacts[id].kind);
  assert.deepEqual(delivered, ['delivery']);
  assert.equal(store.state.tasks[taskId].runIds.length, 2);
  assert.ok(store.events(seenBefore).every((e) => e.type !== 'run.started' || e.payload.provider === 'scripted'));
});

test('boot: station.loaded is logged only when the layout changed; an invalid layout is refused before the log opens', { timeout: 30_000 }, async (t) => {
  const dataDir = tmp();
  const loads = () => fs.readFileSync(path.join(dataDir, 'events.ndjson'), 'utf8').split('\n').filter((l) => l.includes('"type":"station.loaded"')).length;
  (await boot(t, dataDir)).stop();
  (await boot(t, dataDir)).stop();
  assert.equal(loads(), 1, 'an unchanged layout is not re-logged');

  const changed = structuredClone(STATION);
  changed.budgets.stationDailyUsd = 5;
  const stationPath = path.join(tmp(), 'station.json');
  fs.writeFileSync(stationPath, JSON.stringify(changed));
  const station = await startStation({ ...configFor(dataDir), stationPath });
  t.after(station.stop);
  assert.equal(station.store.state.station.budgets.stationDailyUsd, 5);
  station.stop();
  assert.equal(loads(), 2);

  const broken = structuredClone(STATION);
  broken.agents[0].room = 'nowhere';
  broken.hallways.push({ id: 'h-bad', a: 'bridge', b: 'void', path: [] });
  fs.writeFileSync(stationPath, JSON.stringify(broken));
  const freshDir = tmp();
  await assert.rejects(startStation({ ...configFor(freshDir), stationPath }), (err) => {
    assert.match(err.message, /invalid station layout/);
    assert.match(err.message, /- agent orion assigned to unknown room nowhere/);
    assert.match(err.message, /- hallway h-bad links unknown room/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(freshDir, 'events.ndjson')), false, 'nothing was logged');
});

test('one sidecar per data dir: a second boot is refused before it touches the log (RT-1)', { timeout: 30_000 }, async (t) => {
  const dataDir = tmp();
  const a = await boot(t, dataDir);
  // In-flight work the second instance would otherwise "recover" into A's live log.
  await fetch(`${a.base}/api/estop`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-outpost-client': '1' }, body: JSON.stringify({ engaged: true }) });
  await fetch(`${a.base}/api/recipes/pod_listing`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-outpost-client': '1' }, body: '{}' });
  const log = path.join(dataDir, 'events.ndjson');
  const before = fs.readFileSync(log);
  for (const port of ['0', String(new URL(a.url).port)]) { // another port, and the same one
    await assert.rejects(startStation({ ...configFor(dataDir), port: Number(port) }), /data dir .* is already in use by outpost pid \d+/);
  }
  assert.deepEqual(fs.readFileSync(log), before, 'the refused boot appended nothing');
  assert.equal(fs.readFileSync(lockFile(fs.realpathSync(dataDir)), 'utf8').trim(), String(process.pid));

  a.stop();
  assert.equal(fs.existsSync(lockFile(dataDir)), false, 'stop() releases the lock');
  const b = await boot(t, dataDir);
  assert.ok(b.store.state.seq > 0, 'the next boot opens the same log');
  b.stop();

  // A lock left by a process that no longer exists is stale and taken over.
  fs.writeFileSync(lockFile(dataDir), '2147483646\n');
  const c = await boot(t, dataDir);
  c.stop();
});
