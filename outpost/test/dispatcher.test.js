import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeArtifact } from '../sidecar/artifacts.js';
import { route } from '../sidecar/capability.js';
import { createDispatcher, createProviderFor } from '../sidecar/dispatcher.js';
import { createScriptedProvider } from '../sidecar/providers/scripted.js';
import { DEFAULT_SCRIPTS } from '../sidecar/providers/scripts.js';
import { createStore } from '../sidecar/store.js';

const STATION = JSON.parse(fs.readFileSync(new URL('../config/station.json', import.meta.url), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-'));

// ---- fixtures ---------------------------------------------------------------------------

const say = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
const call = (name, input, text = `calling ${name}`) => ({ content: [{ type: 'text', text }, { type: 'tool_use', name, input }], stop_reason: 'tool_use' });
const endTurn = (text) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'scripted', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } });

/** Script: write one workspace file on the first turn, then finish. */
const writer = (file) => ({ messages }) => (messages.length === 1
  ? call('write_file', { path: file, content: `# ${file}\n` })
  : say(`Wrote ${file}.`));

/** A provider whose runs block until released (or aborted), so tests control timing. */
function blockingProvider() {
  const release = new Map();
  return {
    release: (taskId) => release.get(taskId)(),
    waiting: () => [...release.keys()],
    provider: {
      name: 'test',
      model: 'scripted',
      createMessage({ signal, task }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          release.set(task.taskId, () => resolve(endTurn(`finished ${task.title}`)));
        });
      },
    },
  };
}

function setup({ provider, scripts = {}, station = structuredClone(STATION), config = {}, now, dataDir = tmp() } = {}) {
  const store = createStore({ dataDir });
  if (!store.state.station) store.append('station.loaded', { station });
  const p = provider ?? createScriptedProvider({ scripts });
  const dispatcher = createDispatcher({
    store,
    config: { dataDir, provider: 'scripted', modelOverride: null, tickMs: 60_000, ...config },
    station,
    providerFor: () => p,
    imageProvider: null,
    connectors: { etsy: { configured: false } },
    now,
  });
  return { dataDir, store, dispatcher, station };
}

async function waitFor(predicate, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const payloads = (store, type) => store.events().filter((e) => e.type === type).map((e) => e.payload);
const status = (store, id) => store.state.tasks[id].status;
const settled = (store) => store.state.taskOrder.every((id) => ['done', 'failed', 'cancelled'].includes(status(store, id)));

/** No agent ever has two runs open at once, judged from the event order. */
function assertOneRunPerAgent(store) {
  const open = new Map();
  for (const e of store.events()) {
    if (e.type === 'run.started') {
      assert.ok(!open.get(e.payload.agentId), `${e.payload.agentId} started a second run`);
      open.set(e.payload.agentId, true);
    } else if (e.type === 'run.finished') open.set(e.payload.agentId, false);
  }
}

// ---- task records -------------------------------------------------------------------------

test('createTask validates the assignee, inputs, dependencies and parent', () => {
  const { store, dispatcher } = setup();
  assert.throws(() => dispatcher.createTask({ assignee: 'ghost', title: 'x', brief: '' }), /unknown agent "ghost"/);
  assert.throws(() => dispatcher.createTask({ assignee: 'nova', title: 'x', brief: '', inputs: ['art_none'] }), /unknown artifact art_none/);
  assert.throws(() => dispatcher.createTask({ assignee: 'nova', title: 'x', brief: '', dependsOn: ['task_none'] }), /unknown dependency/);
  assert.throws(() => dispatcher.createTask({ assignee: 'nova', title: 'x', brief: '', parentTaskId: 'task_none' }), /unknown parent/);
  assert.throws(() => dispatcher.createTask({ assignee: 'nova', title: '  ', brief: '' }), /title/);
  const id = dispatcher.createTask({ assignee: 'nova', title: 'Scan', brief: 'b' });
  assert.deepEqual(
    { kind: store.state.tasks[id].kind, status: status(store, id), createdBy: store.state.tasks[id].createdBy },
    { kind: 'work', status: 'queued', createdBy: 'operator' },
  );
  assert.equal(store.state.taskOrder.length, 1, 'rejected tasks leave no trace');
});

test('never two runs per agent, and never more than maxConcurrentRuns', async () => {
  const station = structuredClone(STATION);
  station.budgets.maxConcurrentRuns = 2;
  const gate = blockingProvider();
  const { store, dispatcher } = setup({ provider: gate.provider, station });
  const a = dispatcher.createTask({ assignee: 'nova', title: 'A', brief: '' });
  const b = dispatcher.createTask({ assignee: 'nova', title: 'B', brief: '' });
  const c = dispatcher.createTask({ assignee: 'vega', title: 'C', brief: '' });
  const d = dispatcher.createTask({ assignee: 'pixel', title: 'D', brief: '' });

  assert.deepEqual(dispatcher.tick(), [], 'nothing starts before start()');
  dispatcher.start();
  assert.deepEqual(dispatcher.tick(), [a, c], 'B waits for nova, D for a free slot');
  assert.deepEqual(dispatcher.tick(), []);
  await waitFor(() => gate.waiting().length === 2, 'two runs to reach the provider');

  gate.release(a);
  await waitFor(() => status(store, b) === 'running', 'B to start once nova is free');
  assert.equal(status(store, d), 'queued', 'the cap still holds D back');
  gate.release(c);
  await waitFor(() => status(store, d) === 'running', 'D to start');
  await waitFor(() => gate.waiting().length === 4, 'all runs to reach the provider');
  gate.release(b);
  gate.release(d);
  await waitFor(() => settled(store), 'all tasks to finish');
  dispatcher.stop();

  assert.deepEqual([a, b, c, d].map((id) => status(store, id)), ['done', 'done', 'done', 'done']);
  assert.equal(store.state.tasks[a].summary, 'finished A');
  assertOneRunPerAgent(store);
});

test('recipe stages honour `after`: parallel starts, dependency outputs as inputs, handoffs along hallways', async () => {
  const seen = {};
  const scripts = {
    nova: writer('research.md'),
    vega: writer('competitors.md'),
    pixel: writer('design-notes.md'),
    quill: (args) => {
      seen.quill = args.task.inputs;
      return say('Listing drafted.');
    },
    orion: (args) => {
      seen.orion = args.task.inputs;
      return say('Reviewed.');
    },
  };

  const parallel = setup({ provider: blockingProvider().provider });
  const scan = parallel.dispatcher.startRecipe('competitor_scan');
  parallel.dispatcher.start();
  assert.deepEqual(parallel.dispatcher.tick(), scan.taskIds.slice(0, 2), 'stages with after:[] start together');
  assert.deepEqual(parallel.store.state.tasks[scan.taskIds[2]].dependsOn, scan.taskIds.slice(0, 2));
  parallel.dispatcher.stop();

  const { store, dispatcher, station } = setup({ scripts });
  const { recipeRunId, taskIds } = dispatcher.startRecipe('pod_listing', { niche: 'fern mugs' });
  const [research, design, listing, review] = taskIds;
  assert.deepEqual(taskIds.map((id) => store.state.tasks[id].dependsOn), [[], [research], [research, design], [listing]]);
  assert.deepEqual(taskIds.map((id) => store.state.tasks[id].stage), [0, 1, 2, 3]);
  assert.deepEqual(payloads(store, 'recipe.started')[0], { recipeRunId, recipe: 'pod_listing', title: 'Print-on-demand listing: fern mugs', taskIds });

  dispatcher.start();
  await waitFor(() => settled(store), 'the recipe to finish');
  dispatcher.stop();
  assert.deepEqual(taskIds.map((id) => status(store, id)), ['done', 'done', 'done', 'done']);

  const outputs = (id) => store.state.tasks[id].outputs;
  assert.deepEqual(seen.quill, [...outputs(research), ...outputs(design)], 'quill gets the brief and the design');
  assert.deepEqual(seen.orion, outputs(listing));
  assert.deepEqual(store.state.tasks[listing].inputs, [], 'the logged task is unchanged; inputs are resolved at start');

  const order = store.events().map((e) => `${e.type}:${e.payload.taskId}:${e.payload.status ?? ''}`);
  assert.ok(order.indexOf(`task.status:${research}:done`) < order.indexOf(`task.status:${design}:running`), 'design waits for research');

  const hops = payloads(store, 'handoff').map((h) => [h.fromAgent, h.toAgent, h.taskId, h.route]);
  assert.deepEqual(hops, [
    ['nova', 'pixel', design, ['h-research-production']],
    ['nova', 'quill', listing, ['h-research-production']],
    ['quill', 'orion', review, ['h-bridge-production']],
  ], 'pixel -> quill is the same room, so no packet');
  for (const h of payloads(store, 'handoff')) assert.deepEqual(h.route, route(station, h.fromRoom, h.toRoom));
  assert.deepEqual(payloads(store, 'handoff')[0].artifactIds, outputs(research));
});

test('a failed or cancelled dependency cancels everything downstream', () => {
  const { store, dispatcher } = setup();
  const a = dispatcher.createTask({ assignee: 'nova', title: 'A', brief: '' });
  const b = dispatcher.createTask({ assignee: 'pixel', title: 'B', brief: '', dependsOn: [a] });
  const c = dispatcher.createTask({ assignee: 'quill', title: 'C', brief: '', dependsOn: [b] });
  assert.equal(dispatcher.cancelTask(a), true);
  assert.equal(dispatcher.cancelTask(a), false, 'already finished');
  dispatcher.start();
  dispatcher.tick();
  dispatcher.stop();
  assert.deepEqual([a, b, c].map((id) => status(store, id)), ['cancelled', 'cancelled', 'cancelled']);
  assert.match(store.state.tasks[b].reason, new RegExp(`dependency ${a} "A" cancelled`));
  assert.match(store.state.tasks[c].reason, new RegExp(`dependency ${b} "B" cancelled`));
});

test('a queued task for an agent who is no longer on the station fails instead of waiting forever', () => {
  const { store, dispatcher } = setup();
  store.append('task.created', { taskId: 'task_old', title: 'Old', brief: '', assignee: 'retired', createdBy: 'operator' });
  dispatcher.start();
  dispatcher.tick();
  dispatcher.stop();
  assert.equal(status(store, 'task_old'), 'failed');
  assert.match(store.state.tasks.task_old.reason, /agent retired is not on this station/);
});

// ---- routing ------------------------------------------------------------------------------

test('delegate and handoff create child tasks, emit handoffs along the lane, and enforce the layout', () => {
  const { dataDir, store, dispatcher } = setup();
  const parent = dispatcher.createTask({ assignee: 'orion', title: 'Goal', brief: '' });
  const art = writeArtifact({ store, dataDir }, { agentId: 'nova', kind: 'text', title: 'brief', content: '# b' });

  const res = dispatcher.delegate({ fromAgent: 'orion', toAgent: 'flux', title: 'Thumbs', brief: 'b', artifactIds: [art.artifactId], parentTaskId: parent });
  assert.equal(res.ok, true, res.reason);
  const child = store.state.tasks[res.taskId];
  assert.deepEqual(
    { assignee: child.assignee, createdBy: child.createdBy, parentTaskId: child.parentTaskId, inputs: child.inputs },
    { assignee: 'flux', createdBy: 'orion', parentTaskId: parent, inputs: [art.artifactId] },
  );
  const hop = store.events().filter((e) => e.type === 'handoff').at(-1);
  assert.equal(hop.actor, 'orion');
  assert.deepEqual(
    { from: hop.payload.fromRoom, to: hop.payload.toRoom, route: hop.payload.route, taskId: hop.payload.taskId, artifactIds: hop.payload.artifactIds },
    { from: 'bridge', to: 'output', route: ['h-bridge-output'], taskId: res.taskId, artifactIds: [art.artifactId] },
  );

  const peer = dispatcher.handoff({ fromAgent: 'nova', toAgent: 'pixel', title: 'Design', brief: '', artifactIds: [], parentTaskId: parent });
  assert.equal(peer.ok, true);
  assert.deepEqual(payloads(store, 'handoff').at(-1).route, ['h-research-production']);
  const sameRoom = dispatcher.handoff({ fromAgent: 'nova', toAgent: 'vega', title: 'Check', brief: '', artifactIds: [] });
  assert.equal(sameRoom.ok, true);
  assert.deepEqual(payloads(store, 'handoff').at(-1).route, [], 'same room: an empty route');

  const tasksBefore = store.state.taskOrder.length;
  const refusals = [
    dispatcher.delegate({ fromAgent: 'nova', toAgent: 'flux', title: 't', brief: '', artifactIds: [] }),
    dispatcher.handoff({ fromAgent: 'nova', toAgent: 'flux', title: 't', brief: '', artifactIds: [] }),
    dispatcher.delegate({ fromAgent: 'orion', toAgent: 'orion', title: 't', brief: '', artifactIds: [] }),
    dispatcher.delegate({ fromAgent: 'orion', toAgent: 'nova', title: 't', brief: '', artifactIds: ['art_missing'] }),
  ];
  assert.deepEqual(refusals.map((r) => r.ok), [false, false, false, false]);
  assert.match(refusals[0].reason, /no command console/);
  assert.match(refusals[1].reason, /no direct lane/);
  assert.match(refusals[2].reason, /yourself/);
  assert.match(refusals[3].reason, /unknown artifact art_missing/);
  assert.equal(store.state.taskOrder.length, tasksBefore, 'refusals create nothing');
});

test('delegation chains are capped so agents cannot pass work back and forth forever', () => {
  const { dispatcher } = setup();
  let parent = dispatcher.createTask({ assignee: 'orion', title: 'Root', brief: '' });
  let res;
  for (let depth = 2; depth <= 9; depth += 1) {
    res = dispatcher.delegate({ fromAgent: 'orion', toAgent: 'nova', title: `Level ${depth}`, brief: '', artifactIds: [], parentTaskId: parent });
    if (!res.ok) break;
    parent = res.taskId;
  }
  assert.equal(res.ok, false);
  assert.match(res.reason, /8 hand-offs deep; report back to the operator/);
});

// ---- reviews ------------------------------------------------------------------------------

test('a delegating task gets exactly one review, after it and all its children finish', async () => {
  const scripts = {
    orion: ({ task, messages }) => {
      if (task.kind === 'review') return say(`Reviewed ${task.inputs.length} outputs.`);
      if (messages.length > 1) return say('Delegated.');
      return {
        content: [
          { type: 'tool_use', name: 'delegate_task', input: { agent_id: 'nova', title: 'Demand', brief: 'b', artifact_ids: [] } },
          { type: 'tool_use', name: 'delegate_task', input: { agent_id: 'vega', title: 'Competitors', brief: 'b', artifact_ids: [] } },
        ],
        stop_reason: 'tool_use',
      };
    },
    nova: writer('demand.md'),
    vega: writer('competitors.md'),
  };
  const { dataDir, store, dispatcher } = setup({ scripts });
  const goal = dispatcher.createTask({ assignee: 'orion', title: 'Find a niche', brief: 'Original brief text' });
  dispatcher.start();
  await waitFor(() => settled(store) && store.state.taskOrder.length === 4, 'goal, two children and the review to finish');
  dispatcher.stop();

  const reviews = Object.values(store.state.tasks).filter((t) => t.kind === 'review');
  assert.equal(reviews.length, 1);
  const [review] = reviews;
  const children = Object.values(store.state.tasks).filter((t) => t.parentTaskId === goal && t.kind === 'work');
  assert.deepEqual(
    { assignee: review.assignee, parentTaskId: review.parentTaskId, createdBy: review.createdBy, status: review.status },
    { assignee: 'orion', parentTaskId: goal, createdBy: 'system', status: 'done' },
  );
  assert.deepEqual(new Set(review.inputs), new Set(children.flatMap((c) => c.outputs)));
  assert.equal(review.inputs.length, 2);
  assert.match(review.brief, /ORIGINAL BRIEF\nOriginal brief text/);
  assert.match(review.summary, /Reviewed 2 outputs/);
  const createdAt = store.events().findIndex((e) => e.type === 'task.created' && e.payload.taskId === review.taskId);
  for (const id of [goal, ...children.map((c) => c.taskId)]) {
    const doneAt = store.events().findIndex((e) => e.type === 'task.status' && e.payload.taskId === id && e.payload.status === 'done');
    assert.ok(doneAt < createdAt, 'the review waits for the parent and every child');
  }
  const returns = payloads(store, 'handoff').filter((h) => h.taskId === review.taskId);
  assert.deepEqual(returns.map((h) => [h.fromAgent, h.route]).sort(), [['nova', ['h-research-bridge']], ['vega', ['h-research-bridge']]]);

  // A restart re-derives "already reviewed" from the log: no duplicate.
  store.close();
  const again = setup({ scripts, dataDir });
  assert.equal(again.dispatcher.recover().reviewsCreated, 0);
  assert.equal(Object.values(again.store.state.tasks).filter((t) => t.kind === 'review').length, 1);
});

test('recover() creates a review a crash skipped; cancelled parents get none', () => {
  const { dataDir, store } = setup();
  const created = (taskId, assignee, extra = {}) => store.append('task.created', { taskId, title: taskId, brief: '', assignee, createdBy: 'operator', ...extra });
  created('task_p', 'orion');
  created('task_c', 'nova', { parentTaskId: 'task_p' });
  created('task_q', 'orion');
  created('task_d', 'nova', { parentTaskId: 'task_q' });
  store.append('task.status', { taskId: 'task_p', status: 'done' });
  store.append('task.status', { taskId: 'task_c', status: 'done', outputs: [] });
  store.append('task.status', { taskId: 'task_q', status: 'cancelled' });
  store.append('task.status', { taskId: 'task_d', status: 'done', outputs: [] });
  store.close();

  const { store: reopened, dispatcher } = setup({ dataDir });
  assert.equal(dispatcher.recover().reviewsCreated, 1);
  const reviews = Object.values(reopened.state.tasks).filter((t) => t.kind === 'review');
  assert.deepEqual(reviews.map((t) => t.parentTaskId), ['task_p']);
  assert.equal(dispatcher.recover().reviewsCreated, 0, 'idempotent');
});

// ---- approvals ----------------------------------------------------------------------------

function draftArtifact(store, dataDir) {
  const draft = {
    title: 'Fern mug', description: 'An original fern mug.', tags: ['fern'], price_usd: 18, quantity: 5, who_made: 'i_did',
    when_made: 'made_to_order', is_supply: false, artifact_ids: [], ai_disclosure: 'AI assisted.', originality_note: 'Original.',
  };
  return writeArtifact({ store, dataDir }, { agentId: 'quill', kind: 'listing_draft', title: 'Draft', content: JSON.stringify(draft) }).artifactId;
}

const publisher = (draftId) => ({ messages, lastToolResults }) => (messages.length === 1
  ? call('publish_listing', { draft_artifact_id: draftId })
  : say(lastToolResults[0].is_error ? `Not published: ${lastToolResults[0].content}` : `Published: ${lastToolResults[0].content}`));

test('resolveApproval resumes the paused run exactly once', async () => {
  const dataDir = tmp();
  const holder = {};
  const { store, dispatcher } = setup({ dataDir, scripts: { quill: (args) => publisher(holder.draft)(args) } });
  holder.draft = draftArtifact(store, dataDir);
  const id = dispatcher.createTask({ assignee: 'quill', title: 'Publish', brief: '' });
  dispatcher.start();
  await waitFor(() => payloads(store, 'approval.requested').length === 1, 'the approval request');
  const { approvalId } = payloads(store, 'approval.requested')[0];
  assert.equal(status(store, id), 'awaiting_approval');

  assert.equal(dispatcher.resolveApproval('apr_unknown', 'granted'), false);
  assert.equal(dispatcher.resolveApproval(approvalId, 'maybe'), false);
  assert.equal(dispatcher.resolveApproval(approvalId, 'granted', 'ship it'), true);
  assert.equal(dispatcher.resolveApproval(approvalId, 'granted'), false, 'a decision is final');
  await waitFor(() => status(store, id) === 'done', 'the run to finish');
  dispatcher.stop();

  const resolved = store.events().filter((e) => e.type === 'approval.resolved');
  assert.equal(resolved.length, 1);
  assert.deepEqual({ actor: resolved[0].actor, ...resolved[0].payload }, { actor: 'operator', approvalId, decision: 'granted', note: 'ship it' });
  const [receipt] = store.state.tasks[id].outputs;
  assert.equal(store.state.artifacts[receipt].kind, 'publish_receipt');
  assert.match(store.state.tasks[id].summary, /DRY RUN/);
});

test('a denied approval lets the run finish and say so', async () => {
  const dataDir = tmp();
  const holder = {};
  const { store, dispatcher } = setup({ dataDir, scripts: { quill: (args) => publisher(holder.draft)(args) } });
  holder.draft = draftArtifact(store, dataDir);
  const id = dispatcher.createTask({ assignee: 'quill', title: 'Publish', brief: '' });
  dispatcher.start();
  await waitFor(() => payloads(store, 'approval.requested').length === 1, 'the approval request');
  assert.equal(dispatcher.resolveApproval(payloads(store, 'approval.requested')[0].approvalId, 'denied', 'not yet'), true);
  await waitFor(() => status(store, id) === 'done', 'the run to finish');
  dispatcher.stop();
  assert.match(store.state.tasks[id].summary, /Not published: operator denied: not yet/);
  assert.deepEqual(store.state.tasks[id].outputs, []);
});

test('cancelling a task aborts its run and expires its pending approval', async () => {
  const dataDir = tmp();
  const holder = {};
  const { store, dispatcher } = setup({ dataDir, scripts: { quill: (args) => publisher(holder.draft)(args) } });
  holder.draft = draftArtifact(store, dataDir);
  const id = dispatcher.createTask({ assignee: 'quill', title: 'Publish', brief: '' });
  dispatcher.start();
  await waitFor(() => payloads(store, 'approval.requested').length === 1, 'the approval request');
  const { approvalId, runId } = payloads(store, 'approval.requested')[0];

  assert.equal(dispatcher.cancelTask(id), true);
  await waitFor(() => store.state.runs[runId].outcome !== null, 'the run to end');
  dispatcher.stop();
  assert.equal(status(store, id), 'cancelled');
  assert.equal(store.state.runs[runId].outcome, 'aborted');
  assert.equal(store.state.approvals[approvalId].status, 'expired');
  assert.equal(dispatcher.resolveApproval(approvalId, 'granted'), false);
  assert.equal(store.state.agents.quill.status, 'idle');
  assert.equal(payloads(store, 'artifact.created').filter((a) => a.kind === 'publish_receipt').length, 0);
});

// ---- E-STOP, budgets, models ----------------------------------------------------------------

test('E-STOP aborts every run, blocks starts while engaged, and re-queues halted tasks', async () => {
  const gate = blockingProvider();
  const { store, dispatcher } = setup({ provider: gate.provider });
  const a = dispatcher.createTask({ assignee: 'nova', title: 'A', brief: '' });
  const b = dispatcher.createTask({ assignee: 'flux', title: 'B', brief: '' });
  dispatcher.start();
  await waitFor(() => gate.waiting().length === 2, 'both runs to start');

  dispatcher.setEstop(true);
  assert.equal(store.state.estop, true);
  await waitFor(() => status(store, a) === 'queued' && status(store, b) === 'queued', 'halted tasks to be re-queued');
  assert.deepEqual(payloads(store, 'run.finished').map((r) => r.outcome), ['aborted', 'aborted']);
  assert.match(store.state.tasks[a].reason, /halted by E-STOP; re-queued \(attempt 2 of 2\)/);
  const c = dispatcher.createTask({ assignee: 'tally', title: 'C', brief: '' });
  assert.deepEqual(dispatcher.tick(), [], 'nothing starts while engaged');
  assert.equal(status(store, c), 'queued');

  dispatcher.setEstop(false);
  await waitFor(() => [a, b, c].every((id) => status(store, id) === 'running'), 'work to resume');
  await waitFor(() => gate.waiting().length === 3, 'the resumed runs to reach the provider');
  for (const id of [a, b, c]) gate.release(id);
  await waitFor(() => settled(store), 'everything to finish');
  dispatcher.stop();
  assert.deepEqual([a, b, c].map((id) => status(store, id)), ['done', 'done', 'done']);
  assert.equal(store.state.tasks[a].runIds.length, 2);
  assert.equal(payloads(store, 'estop').length, 2);
});

test('spendTodayUsd reads the projected spend for the UTC day of the clock', () => {
  const { store } = setup();
  store.append('spend.recorded', { agentId: 'pixel', category: 'image', model: 'gpt-image-2', usd: 0.25 });
  const at = (ms) => createDispatcher({ store, config: { dataDir: tmp() }, station: STATION, providerFor: () => null, now: () => ms });
  assert.equal(at(Date.now()).spendTodayUsd(), 0.25);
  assert.equal(at(Date.now() - 86_400_000).spendTodayUsd(), 0);
});

test('a spent daily budget holds queued work (logged once) instead of failing it', () => {
  const station = structuredClone(STATION);
  station.budgets.stationDailyUsd = 0.1;
  const { store, dispatcher } = setup({ station });
  store.append('spend.recorded', { agentId: 'pixel', category: 'image', model: 'gpt-image-2', usd: 0.2 });
  const id = dispatcher.createTask({ assignee: 'nova', title: 'A', brief: '' });
  dispatcher.start();
  assert.deepEqual(dispatcher.tick(), []);
  assert.deepEqual(dispatcher.tick(), []);
  dispatcher.stop();
  assert.equal(status(store, id), 'queued');
  const logs = payloads(store, 'log').filter((l) => /daily budget reached/.test(l.message));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
});

test('the model is config.modelOverride, else the agent model; a fixed-model provider wins', async () => {
  const provider = { name: 'anthropic', createMessage: async () => ({ ...endTurn('ok'), model: 'x' }) };
  const plain = setup({ provider });
  const overridden = setup({ provider, config: { modelOverride: 'claude-haiku-4-5' } });
  const scripted = setup({ config: { modelOverride: 'claude-haiku-4-5' } });
  for (const env of [plain, overridden, scripted]) {
    env.dispatcher.createTask({ assignee: 'nova', title: 'A', brief: '' });
    env.dispatcher.start();
  }
  await waitFor(() => [plain, overridden, scripted].every((env) => settled(env.store)), 'runs to finish');
  for (const env of [plain, overridden, scripted]) env.dispatcher.stop();
  const started = (env) => payloads(env.store, 'run.started')[0];
  assert.deepEqual([started(plain).model, started(overridden).model, started(scripted).model], ['claude-opus-5-5', 'claude-haiku-4-5', 'scripted']);
  assert.deepEqual([started(plain).provider, started(scripted).provider], ['anthropic', 'scripted']);
});

test('createProviderFor returns one provider per config, scripted with the demo scripts', async () => {
  const providerFor = createProviderFor({ provider: 'scripted' });
  const p = providerFor(STATION.agents[0]);
  assert.equal(p, providerFor(STATION.agents[1]));
  assert.deepEqual([p.name, p.model], ['scripted', 'scripted']);
  const msg = await p.createMessage({ messages: [{ role: 'user', content: 'go' }], agent: { id: 'tally' }, task: { inputs: [] } });
  assert.equal(msg.content[1].name, 'sync_connector', 'DEFAULT_SCRIPTS drive it');
  assert.ok(DEFAULT_SCRIPTS.tally);
  assert.equal(createProviderFor({ provider: 'anthropic' })().name, 'anthropic');
});

// ---- recovery ------------------------------------------------------------------------------

test('recover() expires approvals, interrupts runs, re-queues or fails tasks, and idles agents', () => {
  const { dataDir, store } = setup();
  const a = (type, payload, actor) => store.append(type, payload, actor);
  a('task.created', { taskId: 'task_1', title: 'one', brief: '', assignee: 'nova', createdBy: 'operator' });
  a('task.created', { taskId: 'task_2', title: 'two', brief: '', assignee: 'quill', createdBy: 'operator' });
  a('task.status', { taskId: 'task_1', status: 'running' });
  a('run.started', { runId: 'run_1', taskId: 'task_1', agentId: 'nova', provider: 'scripted', model: 'scripted', tools: [] }, 'nova');
  a('agent.status', { agentId: 'nova', status: 'thinking', runId: 'run_1', taskId: 'task_1' }, 'nova');
  a('task.status', { taskId: 'task_2', status: 'running' });
  a('run.started', { runId: 'run_2a', taskId: 'task_2', agentId: 'quill', provider: 'scripted', model: 'scripted', tools: [] }, 'quill');
  a('run.finished', { runId: 'run_2a', agentId: 'quill', taskId: 'task_2', outcome: 'interrupted', turns: 0, costUsd: 0 });
  a('run.started', { runId: 'run_2b', taskId: 'task_2', agentId: 'quill', provider: 'scripted', model: 'scripted', tools: [] }, 'quill');
  a('approval.requested', { approvalId: 'apr_1', runId: 'run_2b', agentId: 'quill', taskId: 'task_2', tool: 'publish_listing', summary: 's', input: '{}' }, 'quill');
  a('agent.status', { agentId: 'quill', status: 'awaiting_approval', runId: 'run_2b', taskId: 'task_2' }, 'quill');
  a('task.status', { taskId: 'task_2', status: 'awaiting_approval' }, 'quill');
  store.close();

  const { store: s, dispatcher } = setup({ dataDir });
  const summary = dispatcher.recover();
  assert.deepEqual(summary, { approvalsExpired: 1, runsInterrupted: 2, tasksRequeued: 1, tasksFailed: 1, agentsReset: 2, reviewsCreated: 0 });
  assert.equal(s.state.approvals.apr_1.status, 'expired');
  assert.deepEqual([s.state.runs.run_1.outcome, s.state.runs.run_2b.outcome], ['interrupted', 'interrupted']);
  assert.equal(s.state.tasks.task_1.status, 'queued');
  assert.match(s.state.tasks.task_1.reason, /interrupted by a sidecar restart; re-queued \(attempt 2 of 2\)/);
  assert.equal(s.state.tasks.task_2.status, 'failed');
  assert.match(s.state.tasks.task_2.reason, /gave up after 2 attempts/);
  assert.deepEqual([s.state.agents.nova.status, s.state.agents.quill.status], ['idle', 'idle']);
  assert.deepEqual(dispatcher.recover(), { approvalsExpired: 0, runsInterrupted: 0, tasksRequeued: 0, tasksFailed: 0, agentsReset: 0, reviewsCreated: 0 });
});
