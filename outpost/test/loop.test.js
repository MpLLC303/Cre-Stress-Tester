import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { toolsForAgent } from '../sidecar/capability.js';
import { runAgentLoop, TOOL_RESULT_MAX_CHARS } from '../sidecar/loop.js';
import { costOf } from '../sidecar/pricing.js';
import { createScriptedProvider } from '../sidecar/providers/scripted.js';
import { createStore } from '../sidecar/store.js';

const STATION = JSON.parse(fs.readFileSync(new URL('../config/station.json', import.meta.url), 'utf8'));
const USAGE = { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

// ---- fixtures ---------------------------------------------------------------------------

function setup(agentId = 'pixel', agentOverrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-'));
  const store = createStore({ dataDir });
  const station = structuredClone(STATION);
  store.append('station.loaded', { station });
  store.append('task.created', { taskId: 'task_1', title: 'Make a mug design', brief: 'Original art, typography first.', assignee: agentId, createdBy: 'operator' });
  const agent = { ...station.agents.find((a) => a.id === agentId), ...agentOverrides };
  return { dataDir, store, station, agent, task: store.state.tasks.task_1 };
}

const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };

/** A toolset with the contract's shape whose tools record their calls instead of doing work. */
function fakeToolset(overrides = {}) {
  const ran = [];
  const client = (name, extra = {}) => ({
    name,
    description: `${name} (fake)`,
    input_schema: schema,
    sensitivity: 'safe',
    kind: 'client',
    summarize: (input) => `${name} "${input.text}"`,
    run: async (input, ctx) => {
      ran.push({ name, input, ctx });
      return { ok: true, output: `${name} ok` };
    },
    ...extra,
  });
  const server = (name) => ({ name, kind: 'server', sensitivity: 'safe', definition: { type: `${name}_20260209`, name, max_uses: 5 } });
  const TOOLS = {
    render_svg_design: client('render_svg_design', {
      run: async (input, ctx) => {
        ran.push({ name: 'render_svg_design', input, ctx });
        return { ok: true, output: { saved: input.text }, artifactIds: ['art_svg_1'] };
      },
    }),
    write_file: client('write_file'),
    read_file: client('read_file'),
    list_files: client('list_files'),
    read_artifact: client('read_artifact'),
    publish_listing: client('publish_listing', { sensitivity: 'approval' }),
    deliver_order: client('deliver_order', { sensitivity: 'approval' }),
    memory_read: client('memory_read'),
    web_search: server('web_search'),
    web_fetch: server('web_fetch'),
    ...overrides,
  };
  return {
    ran,
    TOOLS,
    toolDefinitions: (names) =>
      names.map((n) => (TOOLS[n].kind === 'server' ? TOOLS[n].definition : { name: n, description: TOOLS[n].description, input_schema: TOOLS[n].input_schema, strict: true })),
    validateInput: (tool, input) => (typeof input?.text === 'string' ? null : 'text: required string'),
  };
}

/** A provider that replays canned responses (or functions of the request) and records calls. */
function fakeProvider(steps, name = 'anthropic') {
  const calls = [];
  return {
    name,
    calls,
    async createMessage(args) {
      calls.push(args);
      const step = steps[Math.min(calls.length, steps.length) - 1];
      return typeof step === 'function' ? step(args) : step;
    },
  };
}

const msg = (content, stop_reason, extra = {}) => ({ id: `msg_${Math.random()}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, usage: { ...USAGE }, ...extra });
const text = (t) => ({ type: 'text', text: t });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const done = (t = 'Done. Artifacts: none.') => msg([text(t)], 'end_turn');

function run(env, provider, toolset, extra = {}) {
  return runAgentLoop({
    store: env.store,
    dataDir: env.dataDir,
    station: env.station,
    agent: env.agent,
    task: env.task,
    runId: 'run_1',
    provider,
    toolset,
    ctxBase: { config: { marker: 'ctx-base' } },
    signal: new AbortController().signal,
    waitForApproval: async () => ({ decision: 'granted' }),
    stationSpendTodayUsd: () => 0,
    stationDailyBudgetUsd: 15,
    ...extra,
  });
}

const payloads = (store, type) => store.events().filter((e) => e.type === type).map((e) => e.payload);
const statuses = (store) => payloads(store, 'agent.status').map((p) => p.status);
const finished = (store) => payloads(store, 'run.finished').at(-1);
const lastUserContent = (call) => call.messages.at(-1).content;

// ---- tests ------------------------------------------------------------------------------

test('end_turn completes the run with the final text as summary', async () => {
  const env = setup();
  const provider = fakeProvider([done('Made one design. Artifacts: none.')]);
  const tools = fakeToolset();
  const res = await run(env, provider, tools);

  const cost = costOf('claude-opus-5-5', USAGE);
  assert.deepEqual(res, { outcome: 'completed', turns: 1, costUsd: cost, summary: 'Made one design. Artifacts: none.', outputs: [] });
  const started = payloads(env.store, 'run.started')[0];
  const expectedTools = toolsForAgent(env.station, 'pixel').map((g) => g.tool).filter((t) => tools.TOOLS[t]);
  assert.deepEqual(started, { runId: 'run_1', taskId: 'task_1', agentId: 'pixel', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium', tools: expectedTools });
  assert.deepEqual(payloads(env.store, 'run.step')[0], { runId: 'run_1', agentId: 'pixel', turn: 1, stopReason: 'end_turn', usage: USAGE, costUsd: cost, text: 'Made one design. Artifacts: none.' });
  assert.equal(finished(env.store).outcome, 'completed');
  assert.equal(finished(env.store).costUsd, cost);
  assert.deepEqual(statuses(env.store), ['thinking', 'idle']);
  assert.equal(env.store.state.agents.pixel.status, 'idle');

  const call = provider.calls[0];
  assert.equal(call.model, 'claude-opus-5-5');
  assert.equal(call.effort, 'medium');
  assert.equal(call.maxTokens, 16000);
  assert.equal(call.agent, env.agent);
  assert.equal(call.task, env.task);
  assert.match(call.system, /You are PIXEL, POD Designer/);
  assert.match(call.messages[0].content, /^TASK task_1: Make a mug design/);
  assert.deepEqual(call.tools.map((t) => t.name), expectedTools);
  assert.ok(call.tools.every((t) => t.strict === true));
});

test('a granted client tool runs with the run ctx and its artifacts become outputs', async () => {
  const env = setup();
  const provider = fakeProvider([msg([text('Rendering.'), use('toolu_1', 'render_svg_design', { text: 'mug' })], 'tool_use'), done()]);
  const tools = fakeToolset();
  const res = await run(env, provider, tools);

  assert.equal(res.outcome, 'completed');
  assert.deepEqual(res.outputs, ['art_svg_1']);
  assert.equal(tools.ran.length, 1);
  const { ctx } = tools.ran[0];
  assert.equal(ctx.runId, 'run_1');
  assert.equal(ctx.agent, env.agent);
  assert.equal(ctx.task, env.task);
  assert.equal(ctx.store, env.store);
  assert.equal(ctx.config.marker, 'ctx-base');
  assert.equal(ctx.workspaceDir, path.join(env.dataDir, 'workspaces', 'pixel'));
  assert.ok(fs.statSync(ctx.workspaceDir).isDirectory());

  assert.equal(payloads(env.store, 'tool.called')[0].objectId, 'prod-design');
  const result = payloads(env.store, 'tool.result')[0];
  assert.equal(result.ok, true);
  assert.equal(result.callId, 'toolu_1');
  assert.deepEqual(statuses(env.store), ['thinking', 'tool', 'thinking', 'idle']);
  const toolStatus = payloads(env.store, 'agent.status')[1];
  assert.deepEqual(toolStatus, { agentId: 'pixel', status: 'tool', runId: 'run_1', taskId: 'task_1', tool: 'render_svg_design', objectId: 'prod-design' });
  assert.deepEqual(lastUserContent(provider.calls[1]), [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"saved":"mug"}' }]);
});

test('a tool the room does not grant is denied and never runs', async () => {
  const env = setup();
  const provider = fakeProvider([msg([use('toolu_x', 'deliver_order', { text: 'order 7' })], 'tool_use'), done()]);
  const tools = fakeToolset();
  const res = await run(env, provider, tools);

  assert.equal(res.outcome, 'completed');
  assert.equal(tools.ran.length, 0);
  const denied = payloads(env.store, 'tool.denied')[0];
  assert.equal(denied.tool, 'deliver_order');
  assert.match(denied.reason, /not granted by any object in Production Bay/);
  const [block] = lastUserContent(provider.calls[1]);
  assert.equal(block.is_error, true);
  assert.equal(block.tool_use_id, 'toolu_x');
  assert.match(block.content, /not granted/);
  assert.equal(payloads(env.store, 'tool.called').length, 0);
});

test('invalid input is rejected before the tool runs', async () => {
  const env = setup();
  const provider = fakeProvider([msg([use('toolu_1', 'render_svg_design', { title: 'no text' })], 'tool_use'), done()]);
  const tools = fakeToolset();
  await run(env, provider, tools);

  assert.equal(tools.ran.length, 0);
  assert.deepEqual(lastUserContent(provider.calls[1]), [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'invalid input: text: required string', is_error: true }]);
  assert.equal(payloads(env.store, 'tool.result')[0].ok, false);
});

test('a sensitive tool waits for approval and runs when granted', async () => {
  const env = setup();
  const provider = fakeProvider([msg([use('toolu_p', 'publish_listing', { text: 'draft art_1' })], 'tool_use'), done()]);
  const tools = fakeToolset();
  const asked = [];
  const res = await run(env, provider, tools, {
    waitForApproval: async (approvalId) => {
      asked.push(approvalId);
      assert.equal(env.store.state.agents.pixel.status, 'awaiting_approval');
      assert.equal(env.store.state.tasks.task_1.status, 'awaiting_approval');
      assert.equal(tools.ran.length, 0, 'nothing runs before consent');
      return { decision: 'granted', note: 'ship it' };
    },
  });

  assert.equal(res.outcome, 'completed');
  const req = payloads(env.store, 'approval.requested')[0];
  assert.deepEqual(asked, [req.approvalId]);
  assert.match(req.approvalId, /^apr_/);
  assert.equal(req.summary, 'publish_listing "draft art_1"');
  assert.equal(req.tool, 'publish_listing');
  assert.equal(req.taskId, 'task_1');
  const awaiting = payloads(env.store, 'agent.status').find((p) => p.status === 'awaiting_approval');
  assert.equal(awaiting.objectId, 'prod-gate');
  assert.deepEqual(payloads(env.store, 'task.status').map((p) => p.status), ['awaiting_approval', 'running']);
  assert.equal(tools.ran.length, 1);
  assert.equal(lastUserContent(provider.calls[1])[0].is_error, undefined);
});

test('a denied approval returns an error result and the run continues', async () => {
  const env = setup();
  const provider = fakeProvider([msg([use('toolu_p', 'publish_listing', { text: 'draft' })], 'tool_use'), done('Publishing was denied; nothing was sent.')]);
  const tools = fakeToolset();
  const res = await run(env, provider, tools, { waitForApproval: async () => ({ decision: 'denied', note: 'not this week' }) });

  assert.equal(res.outcome, 'completed');
  assert.equal(tools.ran.length, 0);
  assert.deepEqual(lastUserContent(provider.calls[1]), [{ type: 'tool_result', tool_use_id: 'toolu_p', content: 'operator denied: not this week', is_error: true }]);
  assert.equal(payloads(env.store, 'tool.denied')[0].reason, 'operator denied: not this week');
  assert.equal(env.store.state.tasks.task_1.status, 'running');
});

test('aborting while waiting for approval ends the run as aborted and expires the request', async () => {
  const env = setup();
  const controller = new AbortController();
  env.store.subscribe((e) => {
    if (e.type === 'approval.requested') setTimeout(() => controller.abort(), 5);
  });
  const provider = fakeProvider([msg([use('toolu_p', 'publish_listing', { text: 'draft' })], 'tool_use'), done()]);
  const tools = fakeToolset();
  const res = await run(env, provider, tools, {
    signal: controller.signal,
    waitForApproval: () =>
      new Promise((_, reject) => {
        const fail = () => reject(Object.assign(new Error('approval wait aborted'), { name: 'AbortError' }));
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener('abort', fail, { once: true });
      }),
  });

  assert.equal(res.outcome, 'aborted');
  assert.equal(provider.calls.length, 1);
  assert.equal(tools.ran.length, 0);
  const approvalId = payloads(env.store, 'approval.requested')[0].approvalId;
  assert.deepEqual(payloads(env.store, 'approval.resolved'), [{ approvalId, decision: 'expired', note: 'run stopped while waiting' }]);
  assert.equal(env.store.state.approvals[approvalId].status, 'expired');
  assert.equal(finished(env.store).outcome, 'aborted');
  assert.equal(env.store.state.agents.pixel.status, 'idle');
});

test('exceeding the run budget stops before that turn\'s tools run', async () => {
  const env = setup('pixel', { runBudgetUsd: 0.001 });
  const provider = fakeProvider([msg([use('toolu_1', 'render_svg_design', { text: 'mug' })], 'tool_use'), done()]);
  const tools = fakeToolset();
  const res = await run(env, provider, tools);

  assert.equal(res.outcome, 'budget_exceeded');
  assert.equal(res.turns, 1);
  assert.equal(tools.ran.length, 0);
  assert.equal(provider.calls.length, 1);
  assert.match(finished(env.store).error, /exceeded the \$0\.001 run budget/);
  assert.equal(res.costUsd, costOf('claude-opus-5-5', USAGE));
});

test('tool spend recorded during the run counts toward the run budget', async () => {
  const env = setup('pixel', { runBudgetUsd: 0.05 });
  const tools = fakeToolset({
    render_svg_design: {
      ...fakeToolset().TOOLS.render_svg_design,
      run: async (input, ctx) => {
        ctx.store.append('spend.recorded', { agentId: 'pixel', runId: ctx.runId, category: 'image', model: 'gpt-image-1', usd: 0.08 }, 'pixel');
        return { ok: true, output: 'image saved' };
      },
    },
  });
  const provider = fakeProvider([msg([use('toolu_1', 'render_svg_design', { text: 'mug' })], 'tool_use'), done()]);
  const res = await run(env, provider, tools);

  assert.equal(res.outcome, 'budget_exceeded');
  assert.equal(provider.calls.length, 1, 'no further paid call once tool spend blew the budget');
  assert.ok(Math.abs(res.costUsd - (0.08 + costOf('claude-opus-5-5', USAGE))) < 1e-12);
});

test('the station daily budget stops the run before any provider call', async () => {
  const env = setup();
  const provider = fakeProvider([done()]);
  const res = await run(env, provider, fakeToolset(), { stationSpendTodayUsd: () => 15.2, stationDailyBudgetUsd: 15 });

  assert.equal(res.outcome, 'budget_exceeded');
  assert.equal(res.turns, 0);
  assert.equal(provider.calls.length, 0);
  assert.match(finished(env.store).error, /station daily budget reached/);
  assert.deepEqual(statuses(env.store), ['thinking', 'idle']);
});

test('the turn cap ends the run with max_turns', async () => {
  const env = setup('pixel', { maxTurns: 2 });
  let n = 0;
  const provider = fakeProvider([() => msg([use(`toolu_${++n}`, 'read_artifact', { text: 'art_1' })], 'tool_use')]);
  const tools = fakeToolset();
  const res = await run(env, provider, tools);

  assert.equal(res.outcome, 'max_turns');
  assert.equal(res.turns, 2);
  assert.equal(provider.calls.length, 2);
  assert.equal(tools.ran.length, 2);
  assert.match(finished(env.store).error, /2-turn limit/);
});

test('a refusal ends the run as refused', async () => {
  const env = setup();
  const provider = fakeProvider([msg([], 'refusal', { stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' } })]);
  const res = await run(env, provider, fakeToolset());

  assert.equal(res.outcome, 'refused');
  assert.equal(finished(env.store).error, 'model refused (cyber): declined');
  assert.equal(env.store.state.runs.run_1.outcome, 'refused');
});

test('a provider exception fails the run with the SDK error class and status', async () => {
  const env = setup();
  const provider = fakeProvider([
    () => {
      throw new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, undefined, new Headers());
    },
  ]);
  const res = await run(env, provider, fakeToolset());

  assert.equal(res.outcome, 'failed');
  assert.match(res.error, /^RateLimitError: 429 /);
  assert.match(finished(env.store).error, /slow down/);
  assert.equal(env.store.state.agents.pixel.status, 'idle');
});

test('max_tokens fails the run without running the truncated turn\'s tools', async () => {
  const env = setup();
  const tools = fakeToolset();
  const res = await run(env, fakeProvider([msg([use('toolu_1', 'render_svg_design', { text: 'mu' })], 'max_tokens')]), tools);
  assert.equal(res.outcome, 'failed');
  assert.match(res.error, /max_tokens/);
  assert.equal(tools.ran.length, 0);
});

test('pause_turn re-sends the paused turn without adding a user message; server tools never run locally', async () => {
  const env = setup('nova');
  const paused = [
    text('Searching.'),
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'mug niches' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
  ];
  const provider = fakeProvider([msg(paused, 'pause_turn'), done('Three themes found.')]);
  const tools = fakeToolset();
  const res = await run(env, provider, tools);

  assert.equal(res.outcome, 'completed');
  assert.equal(res.turns, 2);
  const second = provider.calls[1].messages;
  assert.equal(second.length, 2);
  assert.equal(second[1].role, 'assistant');
  assert.equal(second[1].content, paused);
  assert.ok(provider.calls[0].tools.some((t) => t.type === 'web_search_20260209'));
  assert.equal(payloads(env.store, 'tool.called').length, 0);
  assert.equal(tools.ran.length, 0);
});

test('parallel tool calls are answered in ONE user message, in order', async () => {
  const env = setup();
  const provider = fakeProvider([
    msg([
      text('Three things at once.'),
      use('toolu_a', 'render_svg_design', { text: 'a' }),
      use('toolu_b', 'write_file', { text: 'b' }),
      use('toolu_c', 'deliver_order', { text: 'c' }),
    ], 'tool_use'),
    done(),
  ]);
  const tools = fakeToolset();
  await run(env, provider, tools);

  const msgs = provider.calls[1].messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[2].role, 'user');
  const results = msgs[2].content;
  assert.deepEqual(results.map((r) => r.tool_use_id), ['toolu_a', 'toolu_b', 'toolu_c']);
  assert.ok(results.every((r) => r.type === 'tool_result'));
  assert.deepEqual(results.map((r) => r.is_error === true), [false, false, true]);
  assert.deepEqual(tools.ran.map((r) => r.name), ['render_svg_design', 'write_file']);
});

test('assistant content is pushed back verbatim and history is never edited', async () => {
  const env = setup();
  const first = [
    { type: 'thinking', thinking: '', signature: 'sig-abc' },
    text('Step one.'),
    use('toolu_1', 'read_artifact', { text: 'art_1' }),
  ];
  const second = [{ type: 'redacted_thinking', data: 'opaque' }, use('toolu_2', 'write_file', { text: 'notes' })];
  const provider = fakeProvider([msg(first, 'tool_use'), msg(second, 'tool_use'), done()]);
  await run(env, provider, fakeToolset());

  const [c1, c2, c3] = provider.calls;
  assert.equal(c1.messages.length, 1, 'each call gets its own snapshot of history');
  assert.equal(c2.messages[1].content, first, 'same array object, untouched');
  assert.deepEqual(c2.messages[1], { role: 'assistant', content: first });
  assert.equal(c3.messages[3].content, second);
  for (let i = 0; i < c2.messages.length; i++) assert.equal(c3.messages[i], c2.messages[i], `message ${i} unchanged`);
  assert.deepEqual(first[0], { type: 'thinking', thinking: '', signature: 'sig-abc' });
});

test('tool exceptions become error results and the run continues; long output is truncated', async () => {
  const env = setup();
  const tools = fakeToolset({
    read_artifact: { ...fakeToolset().TOOLS.read_artifact, run: async () => { throw new Error('disk on fire'); } },
    write_file: { ...fakeToolset().TOOLS.write_file, run: async () => ({ ok: true, output: 'z'.repeat(30000) }) },
  });
  const provider = fakeProvider([msg([use('toolu_1', 'read_artifact', { text: 'x' }), use('toolu_2', 'write_file', { text: 'y' })], 'tool_use'), done()]);
  const res = await run(env, provider, tools);

  assert.equal(res.outcome, 'completed');
  const [failedResult, longResult] = lastUserContent(provider.calls[1]);
  assert.deepEqual(failedResult, { type: 'tool_result', tool_use_id: 'toolu_1', content: 'tool error: disk on fire', is_error: true });
  assert.ok(longResult.content.length <= TOOL_RESULT_MAX_CHARS);
  assert.ok(longResult.content.startsWith('z'.repeat(TOOL_RESULT_MAX_CHARS - 64)));
  assert.match(longResult.content, /truncated, 10064 more chars\]$/);
  const results = payloads(env.store, 'tool.result');
  assert.equal(results[0].ok, false);
  assert.ok(results[1].output.length < 700, 'event previews stay small');
});

test('a model without a price never reaches the provider', async () => {
  const env = setup('pixel', { model: 'claude-unpriced-1' });
  const provider = fakeProvider([done()]);
  const res = await run(env, provider, fakeToolset());
  assert.equal(res.outcome, 'failed');
  assert.match(res.error, /no price for model claude-unpriced-1/);
  assert.equal(provider.calls.length, 0);
});

test('scripted provider: labeled runs, no server tools, deterministic ids, real tools', async () => {
  const env = setup('nova');
  const seen = [];
  const provider = createScriptedProvider({
    scripts: {
      nova: (ctx) => {
        seen.push(ctx);
        if (ctx.turn === 1) {
          return { content: [text('Writing a brief.'), { type: 'tool_use', name: 'write_file', input: { text: 'brief.md' } }, { type: 'tool_use', name: 'publish_listing', input: { text: 'nope' } }], stop_reason: 'tool_use' };
        }
        const [ok, denied] = ctx.lastToolResults;
        return { content: [text(`${ok.name}: ${ok.content}; ${denied.name} error=${denied.is_error}`)], stop_reason: 'end_turn' };
      },
    },
  });
  const tools = fakeToolset();
  const res = await run(env, provider, tools);

  assert.equal(res.outcome, 'completed');
  assert.equal(res.costUsd, 0);
  assert.equal(res.summary, 'write_file: write_file ok; publish_listing error=true');
  const started = payloads(env.store, 'run.started')[0];
  assert.equal(started.provider, 'scripted');
  assert.equal(started.model, 'scripted');
  assert.ok(!started.tools.includes('web_search') && !started.tools.includes('web_fetch'));
  assert.ok(started.tools.includes('write_file'));
  assert.deepEqual(payloads(env.store, 'tool.called').map((p) => p.callId), ['toolu_scripted_1_1_0']);
  assert.equal(payloads(env.store, 'tool.denied')[0].callId, 'toolu_scripted_1_1_1');
  assert.equal(seen[0].agent, env.agent);
  assert.equal(seen[0].task, env.task);
  assert.deepEqual(seen[0].lastToolResults, []);
  assert.deepEqual(payloads(env.store, 'run.step')[0].usage, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

  // A second run through the same provider gets a new run number in its ids.
  const env2 = setup('nova');
  await run(env2, provider, fakeToolset());
  assert.deepEqual(payloads(env2.store, 'tool.called').map((p) => p.callId), ['toolu_scripted_2_1_0']);
});

test('scripted provider: agents without a script get the labeled fallback', async () => {
  const env = setup('tally');
  const provider = createScriptedProvider({ scripts: {} });
  const res = await run(env, provider, fakeToolset());
  assert.equal(res.outcome, 'completed');
  assert.equal(res.summary, 'No scripted behaviour for tally; connect a model (ANTHROPIC_API_KEY) to run this task.');
  const out = await provider.createMessage({ messages: [{ role: 'user', content: 'x' }], agent: { id: 'tally' }, task: {} });
  assert.match(out.id, /^msg_scripted_\d+$/);
  assert.deepEqual(
    { type: out.type, role: out.role, model: out.model, stop_reason: out.stop_reason },
    { type: 'message', role: 'assistant', model: 'scripted', stop_reason: 'end_turn' },
  );
});
