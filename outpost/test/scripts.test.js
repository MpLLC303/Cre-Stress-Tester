import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../sidecar/store.js';
import { runAgentLoop } from '../sidecar/loop.js';
import { createScriptedProvider } from '../sidecar/providers/scripted.js';
import { DEFAULT_SCRIPTS, SCRIPTED_NOTICE, botanicalDesign, hookTexts, scoreVariant, thumbnailVariants } from '../sidecar/providers/scripts.js';
import { planRecipe } from '../sidecar/recipes.js';
import { sanitizeSvg } from '../sidecar/svg.js';
import { newId } from '../sidecar/ids.js';
import { TOOLS, validateInput } from '../sidecar/tools/index.js';
import { checkCall } from '../sidecar/capability.js';

const station = JSON.parse(fs.readFileSync(new URL('../config/station.json', import.meta.url), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-'));

// ---------------------------------------------------------------------------------------------
// Unit level: drive one script with fabricated tool results

/**
 * Run a script turn by turn; `respond(name, input)` fabricates each tool result as
 * {content, isError?}. Every call is checked against the agent's grants and the tool schema.
 */
function simulate(agentId, task, respond, maxTurns = 10) {
  const messages = [{ role: 'user', content: `TASK ${task.taskId}: ${task.title}\n\nBRIEF\n${task.brief}` }];
  const calls = [];
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const out = DEFAULT_SCRIPTS[agentId]({ agent: { id: agentId }, task, messages, turn, lastToolResults: [] });
    messages.push({ role: 'assistant', content: out.content });
    const uses = out.content.filter((b) => b.type === 'tool_use');
    assert.equal(out.stop_reason, uses.length ? 'tool_use' : 'end_turn');
    assert.equal(out.content[0].type, 'text');
    if (!uses.length) return { calls, final: out.content[0].text };
    const results = uses.map((b, i) => {
      assert.equal(b.id, `toolu_scripted_${turn}_${i}`);
      assert.ok(checkCall(station, agentId, b.name).ok, `${agentId} may call ${b.name}`);
      assert.equal(validateInput(TOOLS[b.name], b.input), null, `${b.name} input`);
      calls.push({ name: b.name, input: b.input });
      const r = respond(b.name, b.input);
      return { type: 'tool_result', tool_use_id: b.id, content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content), ...(r.isError ? { is_error: true } : {}) };
    });
    messages.push({ role: 'user', content: results });
  }
  throw new Error(`${agentId} did not finish within ${maxTurns} turns`);
}

const task = (fields) => ({ taskId: 'task_t', title: 'T', brief: '', kind: 'work', inputs: [], ...fields });
const artifact = (id, kind, extra = {}) => ({ artifact_id: id, kind, title: `${kind} ${id}`, agent: 'quill', preview: '', ...extra });

test('scripts emit Anthropic-shaped tool turns with deterministic ids', () => {
  const out = DEFAULT_SCRIPTS.tally({ task: task({}), messages: [{ role: 'user', content: 'go' }], turn: 3 });
  assert.equal(out.stop_reason, 'tool_use');
  assert.deepEqual(out.content[1], { type: 'tool_use', id: 'toolu_scripted_3_0', name: 'sync_connector', input: { connector: 'etsy' } });
});

test('quill handles a denied publish by ending the turn and explaining, without retrying', () => {
  const { calls, final } = simulate('quill', task({ title: 'Publish listing draft art_d1', inputs: ['art_d1'] }), (name) => {
    if (name === 'read_artifact') return { content: artifact('art_d1', 'listing_draft') };
    if (name === 'publish_listing') return { content: 'operator denied: not this week', isError: true };
    throw new Error(`unexpected ${name}`);
  });
  assert.deepEqual(calls.map((c) => c.name), ['read_artifact', 'publish_listing']);
  assert.match(final, /operator denied publication \(not this week\)/i);
  assert.match(final, /will not retry/);
});

test('quill reports a failed publish and a missing design without inventing output', () => {
  const failed = simulate('quill', task({ inputs: ['art_d1'] }), (name) => (name === 'read_artifact'
    ? { content: artifact('art_d1', 'listing_draft') }
    : { content: 'tool error: ETSY_TAXONOMY_ID is not set', isError: true }));
  assert.match(failed.final, /Publication did not happen: tool error: ETSY_TAXONOMY_ID/);
  const empty = simulate('quill', task({ title: 'Write listing draft', inputs: ['art_t1'] }), () => ({ content: artifact('art_t1', 'text') }));
  assert.deepEqual(empty.calls.map((c) => c.name), ['read_artifact']);
  assert.match(empty.final, /nothing to list/);
});

test('flux handles a denied delivery gracefully', () => {
  const pkg = artifact('art_p1', 'package', { agent: 'flux', preview: JSON.stringify({ notes: 'Order ref: FO-9\nVideo title: "Cabin Week"' }) });
  const { calls, final } = simulate('flux', task({ title: 'Deliver order FO-9', inputs: ['art_p1'] }), (name) => (name === 'read_artifact'
    ? { content: pkg }
    : { content: 'operator denied: wrong client', isError: true }));
  assert.equal(calls[1].name, 'deliver_order');
  assert.equal(calls[1].input.order_ref, 'FO-9');
  assert.match(calls[1].input.message, /"Cabin Week"/);
  assert.match(final, /operator denied the delivery \(wrong client\)/i);
});

test('orion turns a goal into list_tasks then a delegation to nova', () => {
  const goal = 'Find a print-on-demand niche for mugs';
  const { calls, final } = simulate('orion', task({ title: 'Operator goal', brief: goal }), (name) => (name === 'list_tasks'
    ? { content: { tasks: [{ task_id: 'task_a', status: 'running' }], total: 1 } }
    : { content: { task_id: 'task_n', assignee: 'nova' } }));
  assert.deepEqual(calls.map((c) => c.name), ['list_tasks', 'delegate_task']);
  assert.deepEqual(calls[0].input, { status: null });
  assert.equal(calls[1].input.agent_id, 'nova');
  assert.match(calls[1].input.brief, new RegExp(`Operator goal: ${goal}`));
  assert.match(calls[1].input.brief, /patterns, never copies/);
  assert.match(final, /task_n/);

  const refused = simulate('orion', task({ brief: goal }), (name) => (name === 'list_tasks' ? { content: { tasks: [] } } : { content: 'delegate refused: E-STOP', isError: true }));
  assert.match(refused.final, /could not assign the research: delegate refused: E-STOP/);
});

test('orion review sends a flawed draft back for revision instead of publishing', () => {
  const bad = { title: 'x'.repeat(150), tags: ['a'], ai_disclosure: '', originality_note: 'o', artifact_ids: ['art_s'] };
  const { calls } = simulate('orion', task({ kind: 'review', inputs: ['art_d'] }), (name) => (name === 'read_artifact'
    ? { content: artifact('art_d', 'listing_draft', { preview: JSON.stringify(bad) }) }
    : { content: { task_id: 'task_rev' } }));
  const delegation = calls.find((c) => c.name === 'delegate_task').input;
  assert.equal(delegation.agent_id, 'quill');
  assert.match(delegation.title, /^Revise listing draft art_d/);
  assert.match(delegation.brief, /title missing or over 140 characters; no AI disclosure/);
});

test('orion refuses to request delivery for a package without an order ref', () => {
  const { calls, final } = simulate('orion', task({ kind: 'review', inputs: ['art_p'] }), () => ({ content: artifact('art_p', 'package', { preview: JSON.stringify({ notes: 'n', files: [{ sha256: 'a'.repeat(64) }] }) }) }));
  assert.deepEqual(calls.map((c) => c.name), ['read_artifact']);
  assert.match(final, /no order ref found/);
});

test('research and design scripts stop cleanly when a tool fails', () => {
  const nova = simulate('nova', task({ brief: 'Niche: "mugs"' }), () => ({ content: 'tool error: disk full', isError: true }));
  assert.match(nova.final, /could not save the document: tool error: disk full/);
  const pixel = simulate('pixel', task({ brief: 'Niche: "garden mugs"' }), () => ({ content: 'svg rejected: too big', isError: true }));
  assert.match(pixel.final, /design was refused: svg rejected/);
  assert.equal(pixel.calls[0].input.title, '"Grow Gently" botanical typography design');
});

test('tally reports ledger numbers it read, even when the connector is not configured', () => {
  const ledger = {
    totals: { verified_revenue_usd: 0, operator_revenue_usd: 12.5, claimed_revenue_usd: 40, fees_usd: 0, costs_usd: 0, net_counted_usd: 12.5, verified_orders: 0, operator_orders: 1 },
    evidence_coverage: 0,
    runtime_spend_usd: { today: 0.12, total: 0.5 },
  };
  const { calls, final } = simulate('tally', task({ title: 'Ledger report' }), (name) => {
    if (name === 'sync_connector') return { content: 'etsy connector not configured (set ETSY_API_KEY, …)', isError: true };
    if (name === 'read_ledger') return { content: ledger };
    return { content: 'saved ops/ledger-report (100 bytes)' };
  });
  assert.deepEqual(calls.map((c) => c.name), ['sync_connector', 'read_ledger', 'memory_write']);
  const report = calls[2].input.content;
  assert.equal(calls[2].input.key, 'ledger-report');
  assert.match(report, /Operator-entered revenue: \$12\.50 over 1 order/);
  assert.match(report, /Agent claims \(never counted\): \$40\.00/);
  assert.match(report, /Evidence coverage: 0%/);
  assert.match(report, /Gap: claims exist with no verified revenue/);
  assert.match(report, /Connector sync: not done/);
  assert.ok(report.includes(SCRIPTED_NOTICE));
  assert.match(final, /Saved to Ops memory/);
});

test('tally floors evidence coverage like the UI and names the UTC day of "today" (TL-14)', () => {
  const ledger = {
    totals: { verified_revenue_usd: 995, operator_revenue_usd: 5, claimed_revenue_usd: 0, fees_usd: 0, costs_usd: 0, net_counted_usd: 1000, verified_orders: 1, operator_orders: 1 },
    evidence_coverage: 0.995,
    runtime_spend_usd: { today: 0.12, total: 0.5, today_utc_date: '2026-10-01' },
    unconverted: { GBP: { entries: 2 } },
  };
  const { calls } = simulate('tally', task({ title: 'Ledger report' }), (name) => (name === 'read_ledger' ? { content: ledger } : { content: 'ok' }));
  const report = calls.find((c) => c.name === 'memory_write').input.content;
  assert.match(report, /Evidence coverage: 99%/, 'never rounded up to 100%');
  assert.match(report, /Runtime spend: \$0\.12 today \(UTC 2026-10-01\), \$0\.50 total/);
  assert.match(report, /Not in the USD figures above: 2 GBP entries/);
});

test('PIXEL draws an original apparel typography SVG that passes the sanitizer', () => {
  for (const phrase of ['Grow Gently', 'Bloom Where The Wild Things Grow', 'Ivy & <Sage>']) {
    const svg = botanicalDesign(phrase);
    const clean = sanitizeSvg(svg);
    assert.equal(clean.ok, true, clean.reason);
    assert.match(svg, /viewBox="0 0 4500 5400"/);
    assert.match(svg, /<textPath href="#headline-arc"/);
    assert.ok(svg.includes(SCRIPTED_NOTICE));
    assert.doesNotMatch(svg, /<rect width="4500"/, 'transparent background for apparel');
    assert.ok((svg.match(/<path/g) || []).length > 60, 'hand-drawn botanicals are built from paths');
    assert.equal(botanicalDesign(phrase), svg, 'deterministic');
  }
  assert.match(botanicalDesign('Grow Gently'), />GROW GENTLY<\/textPath>/);
  assert.match(botanicalDesign('Ivy & <Sage>'), /IVY &amp; &lt;SAGE&gt;/);
});

test('FLUX drafts three distinct high-contrast 1280x720 variants with bold 2-3 word text', () => {
  const hooks = hookTexts('I Survived 7 Days in a Cabin During a Blizzard');
  assert.deepEqual(hooks, ['SNOWED IN', '7 DAYS', 'BLIZZARD CABIN']);
  for (const title of ['How I Fixed My Bike', 'Unboxing', '']) {
    const h = hookTexts(title);
    assert.equal(h.length, 3);
    h.forEach((x) => assert.ok(x.split(' ').length <= 3 && x === x.toUpperCase(), x));
  }
  const variants = thumbnailVariants(hooks, 'seed');
  assert.equal(new Set(variants.map((v) => v.composition)).size, 3);
  assert.equal(new Set(variants.map((v) => v.svg)).size, 3);
  for (const v of variants) {
    const clean = sanitizeSvg(v.svg);
    assert.equal(clean.ok, true, clean.reason);
    assert.match(v.svg, /viewBox="0 0 1280 720"/);
    assert.ok(v.svg.includes(SCRIPTED_NOTICE));
    const s = scoreVariant(v);
    assert.ok(s.contrast >= 7, `${v.label} contrast ${s.contrast}`);
    assert.ok(s.words >= 1 && s.words <= 3);
  }
});

// ---------------------------------------------------------------------------------------------
// End to end: every recipe through the real loop, tools and store with the scripted provider

function makeEnv() {
  const dataDir = tmp();
  const store = createStore({ dataDir });
  store.append('station.loaded', { station });
  const created = [];
  const createTask = ({ assignee, title, brief, createdBy = 'operator', inputs = [], parentTaskId, recipeRunId, kind }) => {
    const taskId = newId('task');
    store.append('task.created', { taskId, title, brief, assignee, createdBy, inputs, parentTaskId, recipeRunId, kind });
    created.push(taskId);
    return taskId;
  };
  const dispatcher = {
    createTask,
    delegate: ({ fromAgent, toAgent, title, brief, artifactIds, parentTaskId }) => ({ ok: true, taskId: createTask({ assignee: toAgent, title, brief, createdBy: fromAgent, inputs: artifactIds, parentTaskId }) }),
    handoff: () => ({ ok: false, reason: 'not used by the scripts' }),
  };
  return { dataDir, store, dispatcher, created, provider: createScriptedProvider({ scripts: DEFAULT_SCRIPTS }) };
}

async function run(env, taskId, { decision = 'granted' } = {}) {
  const t = env.store.state.tasks[taskId];
  const agent = station.agents.find((a) => a.id === t.assignee);
  const res = await runAgentLoop({
    store: env.store,
    dataDir: env.dataDir,
    station,
    agent,
    task: t,
    runId: newId('run'),
    provider: env.provider,
    ctxBase: { config: {}, imageProvider: null, connectors: { etsy: { configured: false } }, dispatcher: env.dispatcher },
    waitForApproval: async () => ({ decision, note: decision === 'denied' ? 'not this week' : undefined }),
  });
  assert.equal(res.outcome, 'completed', `${agent.id}: ${res.error}`);
  env.store.append('task.status', { taskId, status: 'done', outputs: res.outputs, summary: res.summary });
  return res;
}

/** Run a recipe stage by stage, handing each stage its dependencies' outputs. */
async function runRecipe(env, name, params) {
  const plan = planRecipe(name, params);
  const recipeRunId = newId('rr');
  const results = [];
  for (const stage of plan.stages) {
    const inputs = stage.after.flatMap((i) => results[i].outputs);
    const taskId = env.dispatcher.createTask({ assignee: stage.agent, title: stage.title, brief: stage.brief, inputs, recipeRunId });
    results.push({ taskId, ...(await run(env, taskId)) });
  }
  return results;
}

const kindOf = (env, id) => env.store.state.artifacts[id].kind;
const content = (env, id) => fs.readFileSync(path.join(env.dataDir, env.store.state.artifacts[id].path), 'utf8');
const json = (env, id) => JSON.parse(content(env, id));

function assertHonestRun(env) {
  const events = env.store.events();
  assert.ok(events.filter((e) => e.type === 'run.started').every((e) => e.payload.provider === 'scripted'));
  assert.equal(events.filter((e) => e.type === 'tool.denied').length, 0, 'scripts only call tools their room grants');
  assert.equal(events.filter((e) => e.type === 'tool.result' && !e.payload.ok).length, 0, 'no tool call failed');
  for (const id of env.store.state.artifactOrder) assert.ok(content(env, id).includes(SCRIPTED_NOTICE), `${kindOf(env, id)} ${id} is labelled as scripted`);
}

test('pod_listing runs end to end: research, design, listing, review, approved dry-run publish', async () => {
  const env = makeEnv();
  const [research, designStage, listing, review] = await runRecipe(env, 'pod_listing');

  assert.deepEqual(research.outputs.map((id) => kindOf(env, id)), ['text']);
  assert.match(content(env, research.outputs[0]), /Working headline: "Grow Gently"/);
  assert.ok(env.store.events().some((e) => e.type === 'memory.written' && e.payload.namespace === 'research'));

  assert.deepEqual(designStage.outputs.map((id) => kindOf(env, id)), ['svg']);
  const svg = content(env, designStage.outputs[0]);
  assert.equal(sanitizeSvg(svg).ok, true);
  assert.match(svg, />GROW GENTLY<\/textPath>/);

  assert.deepEqual(listing.outputs.map((id) => kindOf(env, id)), ['listing_draft']);
  const draft = json(env, listing.outputs[0]);
  assert.ok(draft.title.length <= 140 && draft.title.startsWith('Grow Gently Sweatshirt'));
  assert.equal(draft.tags.length, 13);
  assert.deepEqual(draft.artifact_ids, designStage.outputs);
  assert.equal(draft.price_usd, 34);

  assert.deepEqual(review.outputs, []);
  const publishTaskId = env.created.at(-1);
  const publishTask = env.store.state.tasks[publishTaskId];
  assert.equal(publishTask.assignee, 'quill');
  assert.equal(publishTask.createdBy, 'orion');
  assert.equal(publishTask.parentTaskId, review.taskId);
  assert.deepEqual(publishTask.inputs, listing.outputs);

  const published = await run(env, publishTaskId);
  assert.ok(env.store.events().some((e) => e.type === 'approval.requested' && e.payload.tool === 'publish_listing'));
  assert.deepEqual(published.outputs.map((id) => kindOf(env, id)), ['publish_receipt']);
  assert.equal(json(env, published.outputs[0]).mode, 'dry_run');
  assert.match(published.summary, /DRY RUN: Nothing was sent to any marketplace/);

  const followUp = env.dispatcher.createTask({ assignee: 'orion', title: 'Review publication', brief: 'Review the child results.', inputs: published.outputs, parentTaskId: review.taskId, kind: 'review', createdBy: 'system' });
  const closing = await run(env, followUp);
  assert.match(closing.summary, /Publication finished as a DRY RUN/);
  assert.equal(env.created.length, 6, 'the closing review delegates nothing further');
  assertHonestRun(env);
});

test('a denied publish ends the run cleanly with no receipt', async () => {
  const env = makeEnv();
  const [, , listing] = await runRecipe(env, 'pod_listing');
  const res = await run(env, env.created.at(-1), { decision: 'denied' });
  assert.deepEqual(res.outputs, []);
  assert.match(res.summary, /operator denied publication \(not this week\)/i);
  assert.equal(env.store.state.artifactOrder.filter((id) => kindOf(env, id) === 'publish_receipt').length, 0);
  assert.ok(listing.outputs.length === 1);
});

test('thumbnail_order runs end to end: intake, three variants, scorecard, package, approved manual delivery', async () => {
  const env = makeEnv();
  const [intake, production, review] = await runRecipe(env, 'thumbnail_order');
  assert.match(content(env, intake.outputs[0]), /Text options: "SNOWED IN" \| "7 DAYS" \| "BLIZZARD CABIN"/);

  const kinds = production.outputs.map((id) => kindOf(env, id));
  assert.deepEqual(kinds, ['svg', 'svg', 'svg', 'text', 'package']);
  const svgs = production.outputs.slice(0, 3).map((id) => content(env, id));
  assert.equal(new Set(svgs).size, 3);
  svgs.forEach((s) => assert.match(s, /viewBox="0 0 1280 720"/));
  const manifest = json(env, production.outputs[4]);
  assert.match(manifest.notes, /^Order ref: DEMO-ORDER-1$/m);
  assert.equal(manifest.files.length, 2);
  assert.match(content(env, production.outputs[3]), /Winner: variant B/);

  assert.deepEqual(review.outputs, []);
  const deliverTask = env.store.state.tasks[env.created.at(-1)];
  assert.equal(deliverTask.assignee, 'flux');
  assert.equal(deliverTask.title, 'Deliver order DEMO-ORDER-1');
  const delivered = await run(env, deliverTask.taskId);
  assert.deepEqual(delivered.outputs.map((id) => kindOf(env, id)), ['delivery']);
  const sheet = json(env, delivered.outputs[0]);
  assert.equal(sheet.order_ref, 'DEMO-ORDER-1');
  assert.match(sheet.message_to_buyer, /"I Survived 7 Days in a Cabin During a Blizzard"/);
  assert.match(delivered.summary, /Manual delivery required: Fiverr has no seller API/);

  const followUp = env.dispatcher.createTask({ assignee: 'orion', title: 'Review delivery', brief: 'Review.', inputs: delivered.outputs, parentTaskId: review.taskId, kind: 'review', createdBy: 'system' });
  assert.match((await run(env, followUp)).summary, /manual delivery required/);
  assertHonestRun(env);
});

test('competitor_scan: parallel briefs, then a synthesis that claims no findings', async () => {
  const env = makeEnv();
  const [demand, competitors, synthesis] = await runRecipe(env, 'competitor_scan');
  assert.match(content(env, demand.outputs[0]), /^# Demand brief: YouTube thumbnail design gigs/);
  assert.match(content(env, competitors.outputs[0]), /^# Competitor brief: YouTube thumbnail design gigs/);
  assert.match(synthesis.summary, /Synthesis of 2 input\(s\)/);
  assert.match(synthesis.summary, /no verified findings/);
  assert.equal(env.created.length, 3);
  assertHonestRun(env);
});

test('ledger_report: TALLY reports what the ledger proves and files it in Ops memory', async () => {
  const env = makeEnv();
  env.store.append('ledger.entry', { entryId: 'l1', kind: 'revenue', amountCents: 2500, currency: 'USD', stream: 'etsy', provenance: 'manual', source: { note: 'operator' }, occurredAt: '2026-09-30T00:00:00Z' });
  env.store.append('ledger.entry', { entryId: 'l2', kind: 'revenue', amountCents: 50000, currency: 'USD', stream: 'etsy', provenance: 'agent_claim', source: { note: 'agent' }, occurredAt: '2026-09-30T00:00:00Z' });
  const [report] = await runRecipe(env, 'ledger_report');
  assert.match(report.summary, /Operator-entered revenue: \$25\.00 over 1 order/);
  assert.match(report.summary, /Agent claims \(never counted\): \$500\.00/);
  const note = fs.readFileSync(path.join(env.dataDir, 'memory', 'ops', 'ledger-report.md'), 'utf8');
  assert.ok(note.includes(SCRIPTED_NOTICE));
  assert.deepEqual(report.outputs, []);
  const failedSync = env.store.events().filter((e) => e.type === 'tool.result' && e.payload.tool === 'sync_connector');
  assert.equal(failedSync[0].payload.ok, false, 'an unconfigured connector is reported, not faked');
});

test('operator goal: ORION checks the board, delegates to NOVA, then reviews the brief', async () => {
  const env = makeEnv();
  const goalTask = env.dispatcher.createTask({ assignee: 'orion', title: 'Operator goal', brief: 'Find a print-on-demand niche for mugs' });
  const first = await run(env, goalTask);
  assert.match(first.summary, /NOVA has research task task_/);
  const researchTask = env.store.state.tasks[env.created.at(-1)];
  assert.equal(researchTask.assignee, 'nova');
  assert.equal(researchTask.parentTaskId, goalTask);

  const research = await run(env, researchTask.taskId);
  assert.match(content(env, research.outputs[0]), /Operator goal: Find a print-on-demand niche for mugs/);
  const reviewTask = env.dispatcher.createTask({ assignee: 'orion', title: 'Review research', brief: 'Review.', inputs: research.outputs, parentTaskId: goalTask, kind: 'review', createdBy: 'system' });
  const review = await run(env, reviewTask);
  assert.match(review.summary, /Synthesis of 1 input/);
  assertHonestRun(env);
});
