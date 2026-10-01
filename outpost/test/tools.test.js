import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../sidecar/store.js';
import { OBJECT_GRANTS, INTRINSIC_TOOLS, toolsForAgent } from '../sidecar/capability.js';
import { TOOLS, toolDefinitions, validateInput } from '../sidecar/tools/index.js';
import { DRY_RUN_NOTE } from '../sidecar/tools/commerce.js';
import { createImageProvider, estimateImageCostUsd, DEFAULT_IMAGE_MODEL } from '../sidecar/images.js';

const station = JSON.parse(fs.readFileSync(new URL('../config/station.json', import.meta.url), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-'));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#abc"/></svg>';

function fakeDispatcher(result = { ok: true, taskId: 'task_child' }) {
  const calls = [];
  const record = (kind) => async (args) => {
    calls.push([kind, args]);
    return result;
  };
  return { calls, delegate: record('delegate'), handoff: record('handoff') };
}

function setup(agentId = 'quill', extra = {}) {
  const dataDir = tmp();
  const store = createStore({ dataDir });
  store.append('station.loaded', { station });
  store.append('task.created', { taskId: 'task_1', title: 'Test task', brief: 'brief', assignee: agentId, createdBy: 'operator' });
  return {
    store,
    dataDir,
    station,
    agent: station.agents.find((a) => a.id === agentId),
    task: store.state.tasks.task_1,
    runId: 'run_1',
    config: {},
    workspaceDir: path.join(dataDir, 'workspaces', agentId),
    imageProvider: null,
    connectors: { etsy: { configured: false } },
    dispatcher: fakeDispatcher(),
    ...extra,
  };
}

/** Run a tool the way the loop does: validate first, then run. */
async function call(name, input, ctx) {
  const tool = TOOLS[name];
  const invalid = validateInput(tool, input);
  assert.equal(invalid, null, `${name} input should validate: ${invalid}`);
  return tool.run(input, ctx);
}

const ofType = (ctx, type) => ctx.store.events().filter((e) => e.type === type);
const artifactJson = (ctx, id) => JSON.parse(fs.readFileSync(path.join(ctx.dataDir, ctx.store.state.artifacts[id].path), 'utf8'));

async function design(ctx, svg = SVG) {
  const res = await call('render_svg_design', { title: 'Test design', svg, notes: 'n' }, ctx);
  assert.equal(res.ok, true, res.output);
  return res.artifactIds[0];
}

// ---------------------------------------------------------------------------------------------
// Registry, definitions, validation

test('every tool an object can grant is registered, with the contract shape', () => {
  const granted = new Set([...Object.values(OBJECT_GRANTS).flat(), ...INTRINSIC_TOOLS]);
  assert.deepEqual([...granted].sort(), Object.keys(TOOLS).sort());
  for (const tool of Object.values(TOOLS)) {
    assert.equal(typeof tool.description, 'string');
    const sentences = tool.description.split(/(?<=[.!?])\s+(?=[A-Z])/).length;
    assert.ok(sentences >= 1 && sentences <= 3, `${tool.name} description has ${sentences} sentences`);
    assert.equal(typeof tool.summarize({ title: 't', path: 'p', artifact_ids: [], agent_id: 'a', key: null, size: 's', kind: 'k', amount_usd: 1, stream: 's', connector: 'etsy', draft_artifact_id: 'd', package_artifact_id: 'p', order_ref: 'o', artifact_id: 'x', dir: null }), 'string');
    if (tool.kind === 'server') continue;
    const s = tool.input_schema;
    assert.equal(s.type, 'object');
    assert.equal(s.additionalProperties, false);
    assert.deepEqual(s.required, Object.keys(s.properties));
    assert.equal(typeof tool.run, 'function');
  }
  const approval = Object.values(TOOLS).filter((t) => t.sensitivity === 'approval').map((t) => t.name).sort();
  assert.deepEqual(approval, ['deliver_order', 'publish_listing']);
});

test('toolDefinitions keeps grant order, marks client tools strict and passes server tools through', () => {
  const defs = toolDefinitions(['web_search', 'write_file', 'web_fetch', 'list_files']);
  assert.deepEqual(defs.map((d) => d.name), ['web_search', 'write_file', 'web_fetch', 'list_files']);
  assert.deepEqual(defs[0], { type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
  assert.deepEqual(defs[2], { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 });
  assert.equal(defs[1].strict, true);
  assert.deepEqual(Object.keys(defs[1]).sort(), ['description', 'input_schema', 'name', 'strict']);
  assert.deepEqual(defs[3].input_schema.properties.dir.type, ['string', 'null']);

  const fromGrants = toolDefinitions(toolsForAgent(station, 'nova'));
  assert.deepEqual(fromGrants.map((d) => d.name), toolsForAgent(station, 'nova').map((g) => g.tool));
  assert.throws(() => toolDefinitions(['no_such_tool']), /unknown tool/);
});

test('API schemas drop constraints strict mode rejects and describe them instead', () => {
  const all = toolDefinitions(Object.keys(TOOLS));
  const banned = ['maxLength', 'minLength', 'minimum', 'maximum', 'maxItems', 'minItems'];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const key of banned) assert.equal(Object.hasOwn(node, key), false, `found ${key}`);
    Object.values(node).forEach(walk);
  };
  all.forEach((d) => walk(d.input_schema));
  const listing = all.find((d) => d.name === 'create_listing_draft').input_schema.properties;
  assert.match(listing.title.description, /At most 140 characters/);
  assert.match(listing.tags.description, /At least 1 item\. At most 13 items\./);
  assert.match(listing.tags.items.description, /At most 20 characters/);
  assert.match(listing.price_usd.description, /Minimum 0\.2/);
  // the registry itself still carries the limits for validateInput
  assert.equal(TOOLS.create_listing_draft.input_schema.properties.title.maxLength, 140);
});

test('validateInput enforces types, null unions, required, enum, lengths, items and bounds', () => {
  const v = (name, input) => validateInput(TOOLS[name], input);
  assert.equal(v('list_files', { dir: null }), null);
  assert.equal(v('list_files', { dir: 'a' }), null);
  assert.match(v('list_files', {}), /missing required field "dir"/);
  assert.match(v('list_files', { dir: 3 }), /expected string or null/);
  assert.match(v('read_file', { path: 'a', extra: 1 }), /unexpected field "extra"/);
  assert.match(v('read_file', null), /expected object/);
  assert.match(v('generate_image', { title: 't', prompt: 'p', size: '512x512' }), /must be one of/);
  assert.match(v('list_tasks', { status: 'bogus' }), /must be one of/);
  assert.equal(v('list_tasks', { status: null }), null);
  assert.match(v('read_file', { path: 'x'.repeat(301) }), /longer than 300/);
  const listing = { title: 't', description: 'd', tags: ['a'], price_usd: 1, quantity: 1, when_made: 'made_to_order', who_made: 'i_did', production_partner_ids: null, artifact_ids: ['art_x'], ai_disclosure: 'a', originality_note: 'o' };
  assert.equal(v('create_listing_draft', listing), null);
  assert.match(v('create_listing_draft', { ...listing, tags: Array(14).fill('a') }), /more than 13 items/);
  assert.match(v('create_listing_draft', { ...listing, tags: [] }), /fewer than 1 items/);
  assert.match(v('create_listing_draft', { ...listing, tags: ['x'.repeat(21)] }), /tags\[0\]: longer than 20/);
  assert.match(v('create_listing_draft', { ...listing, price_usd: 0.19 }), /at least 0.2/);
  assert.match(v('create_listing_draft', { ...listing, quantity: 1.5 }), /expected integer/);
  assert.match(v('create_listing_draft', { ...listing, quantity: 1000 }), /at most 999/);
  assert.equal(validateInput(TOOLS.web_search, { anything: true }), null);
});

// ---------------------------------------------------------------------------------------------
// Files

test('write_file registers an artifact by extension and read/list round-trip', async () => {
  const ctx = setup('nova');
  const md = await call('write_file', { path: 'notes/brief.md', content: '# Hi' }, ctx);
  assert.equal(md.ok, true);
  assert.equal(md.output.kind, 'text');
  assert.equal(md.output.path, 'notes/brief.md');
  const meta = ctx.store.state.artifacts[md.artifactIds[0]];
  assert.equal(meta.agentId, 'nova');
  assert.equal(meta.taskId, 'task_1');
  assert.equal(meta.runId, 'run_1');

  const json = await call('write_file', { path: 'data.json', content: '{"a":1}' }, ctx);
  assert.equal(ctx.store.state.artifacts[json.artifactIds[0]].kind, 'json');
  const txt = await call('write_file', { path: 'a.txt', content: 'plain' }, ctx);
  assert.equal(ctx.store.state.artifacts[txt.artifactIds[0]].mime, 'text/plain; charset=utf-8');
  const svg = await call('write_file', { path: 'art.svg', content: SVG }, ctx);
  assert.equal(ctx.store.state.artifacts[svg.artifactIds[0]].kind, 'svg');

  assert.deepEqual(await call('read_file', { path: 'notes/brief.md' }, ctx), { ok: true, output: '# Hi' });
  const listed = await call('list_files', { dir: null }, ctx);
  assert.deepEqual(listed.output.entries.map((e) => e.name), ['a.txt', 'art.svg', 'data.json', 'notes/']);
  const sub = await call('list_files', { dir: 'notes' }, ctx);
  assert.deepEqual(sub.output.entries, [{ name: 'brief.md', type: 'file', bytes: 4 }]);
});

test('write_file rejects unsupported types, invalid JSON, unsafe SVG and oversized content', async () => {
  const ctx = setup('nova');
  assert.match((await call('write_file', { path: 'run.sh', content: 'x' }, ctx)).output, /unsupported file type/);
  assert.match((await call('write_file', { path: 'a.json', content: '{nope' }, ctx)).output, /not valid JSON/);
  assert.match((await call('write_file', { path: 'a.svg', content: '<svg><script>1</script></svg>' }, ctx)).output, /svg rejected/);
  assert.match((await call('write_file', { path: 'big.md', content: 'x'.repeat(1024 * 1024 + 1) }, ctx)).output, /exceeds/);
  assert.equal(ofType(ctx, 'artifact.created').length, 0);
});

test('workspace jail refuses traversal, absolute paths and NUL bytes', async () => {
  const ctx = setup('nova');
  for (const p of ['../escape.md', 'a/../../escape.md', '..', path.join(os.tmpdir(), 'abs.md'), 'x\0.md', 'C:evil.md']) {
    await assert.rejects(() => call('write_file', { path: p, content: 'x' }, ctx), /relative|\.\.|NUL/);
    await assert.rejects(() => call('read_file', { path: p }, ctx), /relative|\.\.|NUL/);
  }
  assert.equal(fs.existsSync(path.join(ctx.dataDir, 'workspaces', 'escape.md')), false);
});

test('workspace jail refuses symlink escapes, including dangling links', async () => {
  const ctx = setup('nova');
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
  fs.mkdirSync(ctx.workspaceDir, { recursive: true });
  fs.symlinkSync(outside, path.join(ctx.workspaceDir, 'link'));
  fs.symlinkSync(path.join(outside, 'nothing-here.md'), path.join(ctx.workspaceDir, 'dangling.md'));

  await assert.rejects(() => call('read_file', { path: 'link/secret.md' }, ctx), /symlink/);
  await assert.rejects(() => call('write_file', { path: 'link/new.md', content: 'x' }, ctx), /symlink/);
  await assert.rejects(() => call('list_files', { dir: 'link' }, ctx), /symlink/);
  await assert.rejects(() => call('write_file', { path: 'dangling.md', content: 'x' }, ctx), /symlink/);
  assert.equal(fs.existsSync(path.join(outside, 'new.md')), false);
  assert.equal(fs.existsSync(path.join(outside, 'nothing-here.md')), false);

  // a link that stays inside the workspace is fine
  fs.mkdirSync(path.join(ctx.workspaceDir, 'real'));
  fs.symlinkSync(path.join(ctx.workspaceDir, 'real'), path.join(ctx.workspaceDir, 'alias'));
  assert.equal((await call('write_file', { path: 'alias/ok.md', content: 'fine' }, ctx)).ok, true);
});

test('read_file refuses directories, missing files and files over 1 MB', async () => {
  const ctx = setup('nova');
  fs.mkdirSync(path.join(ctx.workspaceDir, 'dir'), { recursive: true });
  fs.writeFileSync(path.join(ctx.workspaceDir, 'huge.md'), Buffer.alloc(1024 * 1024 + 1, 'a'));
  assert.match((await call('read_file', { path: 'dir' }, ctx)).output, /not a file/);
  assert.match((await call('read_file', { path: 'missing.md' }, ctx)).output, /no such file/);
  assert.match((await call('read_file', { path: 'huge.md' }, ctx)).output, /limit/);
});

test('read_artifact returns meta and preview; list_artifacts lists newest first', async () => {
  const ctx = setup('nova');
  const a = (await call('write_file', { path: 'a.md', content: 'first' }, ctx)).artifactIds[0];
  const b = (await call('write_file', { path: 'b.md', content: 'second' }, ctx)).artifactIds[0];
  const read = await call('read_artifact', { artifact_id: a }, ctx);
  assert.equal(read.output.kind, 'text');
  assert.equal(read.output.agent, 'nova');
  assert.equal(read.output.preview, 'first');
  assert.equal((await call('read_artifact', { artifact_id: 'art_missing' }, ctx)).ok, false);
  const list = await call('list_artifacts', {}, ctx);
  assert.deepEqual(list.output.artifacts.map((x) => x.artifact_id), [b, a]);
});

// ---------------------------------------------------------------------------------------------
// Memory

test('memory is room-scoped, key-checked and emits memory.written', async () => {
  const nova = setup('nova');
  assert.match((await call('memory_write', { key: 'Bad Key', content: 'x' }, nova)).output, /must match/);
  assert.equal((await call('memory_write', { key: 'niche-notes', content: 'pastels sell' }, nova)).ok, true);
  const [ev] = ofType(nova, 'memory.written');
  assert.deepEqual(ev.payload, { agentId: 'nova', namespace: 'research', key: 'niche-notes', bytes: 12 });
  assert.equal(fs.readFileSync(path.join(nova.dataDir, 'memory', 'research', 'niche-notes.md'), 'utf8'), 'pastels sell');
  assert.deepEqual((await call('memory_read', { key: null }, nova)).output, { namespace: 'research', keys: [{ key: 'niche-notes', bytes: 12 }] });
  assert.equal((await call('memory_read', { key: 'niche-notes' }, nova)).output, 'pastels sell');
  assert.equal((await call('memory_read', { key: 'missing' }, nova)).ok, false);

  // vega shares the Research Lab namespace; tally (Ops) does not see it
  const vega = { ...nova, agent: station.agents.find((a) => a.id === 'vega') };
  assert.equal((await call('memory_read', { key: 'niche-notes' }, vega)).output, 'pastels sell');
  const tally = { ...nova, agent: station.agents.find((a) => a.id === 'tally') };
  assert.deepEqual((await call('memory_read', { key: null }, tally)).output, { namespace: 'ops', keys: [] });
});

// ---------------------------------------------------------------------------------------------
// Design and images

test('render_svg_design stores a sanitized svg with the notes inside', async () => {
  const ctx = setup('pixel');
  const res = await call('render_svg_design', { title: 'Leaf <one>', svg: '<svg viewBox="0 0 1 1"><rect/></svg>', notes: 'sage & blush' }, ctx);
  assert.equal(res.ok, true);
  const meta = ctx.store.state.artifacts[res.artifactIds[0]];
  assert.equal(meta.kind, 'svg');
  const body = fs.readFileSync(path.join(ctx.dataDir, meta.path), 'utf8');
  assert.match(body, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 1 1"><desc>sage &amp; blush<\/desc><rect\/><\/svg>$/);
  const bad = await call('render_svg_design', { title: 't', svg: '<svg onload="x()"></svg>', notes: '' }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.output, /svg rejected/);
});

test('generate_image without a provider explains how to configure one', async () => {
  const ctx = setup('pixel');
  const res = await call('generate_image', { title: 't', prompt: 'p', size: '1024x1024' }, ctx);
  assert.equal(res.ok, false);
  for (const name of ['OUTPOST_IMAGE_PROVIDER=openai', 'OUTPOST_IMAGE_MODEL', 'OPENAI_API_KEY']) assert.ok(res.output.includes(name), name);
  assert.equal(ofType(ctx, 'spend.recorded').length, 0);
});

test('generate_image records spend, then stores the image artifact', async () => {
  const requests = [];
  const imageProvider = { name: 'fake', model: 'gpt-image-2', generate: async (r) => { requests.push(r); return { buffer: PNG, mime: 'image/png', requestId: 'req_1', estimatedCostUsd: 0.041 }; } };
  const ctx = setup('pixel', { imageProvider });
  const res = await call('generate_image', { title: 'Fern', prompt: 'an original fern', size: '1536x1024' }, ctx);
  assert.equal(res.ok, true);
  assert.deepEqual(requests.map(({ prompt, size }) => ({ prompt, size })), [{ prompt: 'an original fern', size: '1536x1024' }]);
  assert.ok(Object.hasOwn(requests[0], 'signal'), 'the run signal is passed so E-STOP can abort the request');
  const [spend] = ofType(ctx, 'spend.recorded');
  assert.deepEqual(spend.payload, { agentId: 'pixel', runId: 'run_1', category: 'image', model: 'gpt-image-2', usd: 0.041, detail: 'estimate for one 1536x1024 image' });
  const meta = ctx.store.state.artifacts[res.artifactIds[0]];
  assert.equal(meta.kind, 'image');
  assert.equal(meta.mime, 'image/png');
  assert.match(meta.path, /image\.png$/);
  assert.ok(ofType(ctx, 'spend.recorded')[0].seq < ofType(ctx, 'artifact.created')[0].seq);

  const unpriced = setup('pixel', { imageProvider: { ...imageProvider, generate: async () => ({ buffer: PNG, mime: 'image/png', requestId: null, estimatedCostUsd: null }) } });
  await call('generate_image', { title: 'x', prompt: 'p', size: '1024x1024' }, unpriced);
  const [zero] = ofType(unpriced, 'spend.recorded');
  assert.equal(zero.payload.usd, 0);
  assert.equal(zero.payload.detail, 'price unknown');
});

test('image provider: config gating, request shape, response parsing, key never in errors', async () => {
  assert.equal(createImageProvider(null), null);
  assert.equal(createImageProvider({ provider: null, model: null, apiKey: 'k' }), null);
  assert.equal(createImageProvider({ provider: 'openai', model: null, apiKey: null }), null);
  assert.throws(() => createImageProvider({ provider: 'other', model: null, apiKey: 'k' }), /unsupported image provider/);

  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: PNG.toString('base64') }] }), { status: 200, headers: { 'x-request-id': 'req_abc' } });
  };
  const provider = createImageProvider({ provider: 'openai', model: null, apiKey: 'sk-secret' }, { fetchImpl });
  assert.equal(provider.model, DEFAULT_IMAGE_MODEL);
  const out = await provider.generate({ prompt: 'leaf', size: '1024x1024' });
  assert.equal(seen[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-secret');
  assert.deepEqual(JSON.parse(seen[0].init.body), { model: 'gpt-image-2', prompt: 'leaf', size: '1024x1024', quality: 'medium', n: 1, output_format: 'png' });
  assert.ok(out.buffer.equals(PNG));
  assert.equal(out.mime, 'image/png');
  assert.equal(out.requestId, 'req_abc');
  assert.equal(out.estimatedCostUsd, 0.053);

  const failing = createImageProvider({ provider: 'openai', model: 'gpt-image-1', apiKey: 'sk-secret' }, {
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'bad key sk-secret' } }), { status: 401 }),
  });
  await assert.rejects(() => failing.generate({ prompt: 'x', size: '1024x1024' }), (err) => /HTTP 401/.test(err.message) && !err.message.includes('sk-secret'));
  const garbage = createImageProvider({ provider: 'openai', model: null, apiKey: 'k' }, {
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] })),
  });
  await assert.rejects(() => garbage.generate({ prompt: 'x', size: '1024x1024' }), /not a PNG/);

  assert.equal(estimateImageCostUsd('gpt-image-2-2026-04-21', '1536x1024'), 0.041);
  assert.equal(estimateImageCostUsd('gpt-image-9', '1024x1024'), null);
});

// ---------------------------------------------------------------------------------------------
// Commerce

const goodListing = (designId) => ({
  title: 'Grow Gently Sweatshirt',
  description: 'An original design.',
  tags: ['garden sweatshirt', "gardener's gift", 'plant-lover'],
  price_usd: 34.999,
  quantity: 25,
  when_made: 'made_to_order',
  who_made: 'i_did',
  production_partner_ids: null,
  artifact_ids: [designId],
  ai_disclosure: 'Drafted with AI assistance.',
  originality_note: 'Original artwork.',
});

/** The operator steps every publish receipt must state, whatever the mode. */
function assertBeforeActivation(receipt) {
  const steps = receipt.before_activation.join('\n');
  assert.match(steps, /DRAFTS and never activates them/);
  assert.match(steps, /"How it's made" \/ AI-generator disclosure in Shop Manager/);
  assert.match(steps, /API does not expose that field/);
  assert.match(steps, /SVG designs must be rasterized to PNG or JPEG before upload/);
  assert.match(steps, /production partner/);
}

test('create_listing_draft writes an Etsy-shaped draft', async () => {
  const ctx = setup('quill');
  const res = await call('create_listing_draft', goodListing(await design(ctx)), ctx);
  assert.equal(res.ok, true, res.output);
  const draft = artifactJson(ctx, res.artifactIds[0]);
  assert.equal(ctx.store.state.artifacts[res.artifactIds[0]].kind, 'listing_draft');
  assert.equal(draft.who_made, 'i_did');
  assert.equal(draft.production_partner_ids, null);
  assert.equal(draft.is_supply, false);
  assert.equal(draft.price_usd, 35);
  assert.equal(draft.when_made, 'made_to_order');
  assert.equal(draft.created_by, 'quill');
  assert.match(res.output.partner_note, /No production partner declared.*print-on-demand.*declare that partner.*re-verify on etsy\.com/);
});

test('create_listing_draft takes who_made and production partners as input (no hard-coded i_did)', async () => {
  const schema = TOOLS.create_listing_draft.input_schema;
  assert.deepEqual(schema.properties.who_made.enum, ['i_did', 'someone_else', 'collective']);
  assert.deepEqual(schema.properties.production_partner_ids.type, ['array', 'null']);
  assert.ok(schema.required.includes('who_made') && schema.required.includes('production_partner_ids'), 'strict: nullable fields are still required');
  const [api] = toolDefinitions(['create_listing_draft']);
  assert.equal(api.strict, true);
  assert.deepEqual(api.input_schema.properties.production_partner_ids.type, ['array', 'null']);
  assert.equal(api.input_schema.properties.production_partner_ids.items.type, 'integer');
  assert.match(TOOLS.create_listing_draft.description, /print-on-demand made by a production partner, Etsy's reported guidance is to declare that partner/);
  assert.match(TOOLS.create_listing_draft.description, /re-verify on etsy\.com/);
  assert.doesNotMatch(TOOLS.create_listing_draft.description, /who_made is "i_did"/);

  const v = (patch) => validateInput(TOOLS.create_listing_draft, { ...goodListing('art_x'), ...patch });
  assert.match(v({ who_made: 'me' }), /who_made: must be one of/);
  const { who_made: _w, ...noWhoMade } = goodListing('art_x');
  assert.match(validateInput(TOOLS.create_listing_draft, noWhoMade), /missing required field "who_made"/);
  const { production_partner_ids: _p, ...noPartners } = goodListing('art_x');
  assert.match(validateInput(TOOLS.create_listing_draft, noPartners), /missing required field "production_partner_ids"/);
  assert.match(v({ production_partner_ids: ['p1'] }), /production_partner_ids\[0\]: expected integer/);
  assert.match(v({ production_partner_ids: 5 }), /expected array or null/);
  assert.match(v({ production_partner_ids: Array.from({ length: 11 }, (_, i) => i + 1) }), /more than 10 items/);
  assert.equal(v({ who_made: 'someone_else', production_partner_ids: [4021] }), null);

  const ctx = setup('quill');
  const d = await design(ctx);
  const res = await call('create_listing_draft', { ...goodListing(d), who_made: 'someone_else', production_partner_ids: [4021, 4022] }, ctx);
  assert.equal(res.ok, true, res.output);
  const draft = artifactJson(ctx, res.artifactIds[0]);
  assert.equal(draft.who_made, 'someone_else');
  assert.deepEqual(draft.production_partner_ids, [4021, 4022]);
  assert.equal(res.output.partner_note, undefined);
  const empty = await call('create_listing_draft', { ...goodListing(d), who_made: 'collective', production_partner_ids: [] }, ctx);
  assert.equal(artifactJson(ctx, empty.artifactIds[0]).production_partner_ids, null, 'an empty list is stored as none');

  // the same rules hold if the schema check were bypassed
  const run = (patch) => TOOLS.create_listing_draft.run({ ...goodListing(d), ...patch }, ctx);
  assert.match((await run({ who_made: 'nobody' })).output, /who_made must be one of i_did, someone_else, collective/);
  assert.match((await run({ production_partner_ids: [7, 7] })).output, /duplicates/);
  assert.match((await run({ production_partner_ids: [0] })).output, /positive whole numbers/);
  assert.match((await run({ production_partner_ids: 'x' })).output, /array of Etsy production partner ids, or null/);
});

test('create_listing_draft enforces Etsy limits and the honesty fields', async () => {
  const ctx = setup('quill');
  const d = await design(ctx);
  const text = (await call('write_file', { path: 'n.md', content: 'x' }, setup('quill', { store: ctx.store, dataDir: ctx.dataDir }))).artifactIds[0];
  const cases = [
    [{ tags: ['Grow™'] }, /™, © or ®/],
    [{ tags: ['bad!tag'] }, /letters, numbers, spaces/],
    [{ tags: ['dup', 'DUP'] }, /duplicated/],
    [{ tags: ['   '] }, /may not be empty/],
    [{ ai_disclosure: '  ' }, /ai_disclosure is required/],
    [{ originality_note: '' }, /originality_note is required/],
    [{ description: ' ' }, /description is empty/],
    [{ title: '   ' }, /title is empty/],
    [{ artifact_ids: ['art_nope'] }, /unknown artifact/],
    [{ artifact_ids: [text] }, /expected svg or image/],
  ];
  for (const [patch, pattern] of cases) {
    const res = await call('create_listing_draft', { ...goodListing(d), ...patch }, ctx);
    assert.equal(res.ok, false, JSON.stringify(patch));
    assert.match(res.output, pattern);
  }
  // limits also hold if the schema check were bypassed
  const run = (patch) => TOOLS.create_listing_draft.run({ ...goodListing(d), ...patch }, ctx);
  assert.match((await run({ title: 'x'.repeat(141) })).output, /141 characters/);
  assert.match((await run({ tags: Array.from({ length: 14 }, (_, i) => `t${i}`) })).output, /1 to 13 tags/);
  assert.match((await run({ tags: ['x'.repeat(21)] })).output, /Etsy allows 20/);
  assert.match((await run({ price_usd: 0.19 })).output, /price_usd/);
  assert.match((await run({ quantity: 0 })).output, /quantity/);
  assert.match((await run({ when_made: 'vintage' })).output, /when_made/);
  assert.equal(ofType(ctx, 'artifact.created').filter((e) => e.payload.kind === 'listing_draft').length, 0);
});

test('publish_listing without a connector is a labelled dry run', async () => {
  const ctx = setup('quill');
  const draftId = (await call('create_listing_draft', goodListing(await design(ctx)), ctx)).artifactIds[0];
  const res = await call('publish_listing', { draft_artifact_id: draftId }, ctx);
  assert.equal(res.ok, true);
  assert.match(res.output, /^DRY RUN: Nothing was sent to any marketplace\./);
  const receipt = artifactJson(ctx, res.artifactIds[0]);
  assert.equal(ctx.store.state.artifacts[res.artifactIds[0]].kind, 'publish_receipt');
  assert.equal(receipt.mode, 'dry_run');
  assert.equal(receipt.note, DRY_RUN_NOTE);
  assert.match(receipt.would_send.description, /Drafted with AI assistance\./);
  assert.equal(receipt.would_send.who_made, 'i_did');
  assert.match(receipt.image_note, /rasterize/);
  assertBeforeActivation(receipt);
  assert.match(res.output, /would create an Etsy DRAFT listing: Outpost never activates it/);
  assert.match(res.output, /"How it's made" \/ AI disclosure there \(not in the API\)/);
  assert.match(res.output, /rasterize any SVG design to PNG\/JPEG/);
  await assert.rejects(() => call('publish_listing', { draft_artifact_id: res.artifactIds[0] }, ctx), /not a listing_draft/);
});

test('publish_listing with Etsy configured creates a draft and uploads only PNG/JPEG designs', async () => {
  const sent = [];
  const etsy = {
    configured: true,
    createDraftListing: async (payload) => { sent.push(['draft', payload]); return { listingId: 555, url: 'https://www.etsy.com/listing/555' }; },
    uploadListingImage: async (id, buf, name) => { sent.push(['image', id, buf.length, name]); return { imageId: 9 }; },
  };
  const ctx = setup('quill', { connectors: { etsy } });
  const svgId = await design(ctx);
  const png = await call('generate_image', { title: 'p', prompt: 'p', size: '1024x1024' },
    { ...ctx, imageProvider: { name: 'f', model: 'gpt-image-2', generate: async () => ({ buffer: PNG, mime: 'image/png', requestId: null, estimatedCostUsd: 0.053 }) } });
  const draftId = (await call('create_listing_draft', { ...goodListing(svgId), artifact_ids: [svgId, png.artifactIds[0]] }, ctx)).artifactIds[0];
  const res = await call('publish_listing', { draft_artifact_id: draftId }, ctx);
  assert.equal(res.ok, true);
  assert.match(res.output, /DRAFT listing 555/);
  const [, payload] = sent[0];
  assert.deepEqual(Object.keys(payload).sort(), ['description', 'is_supply', 'price', 'quantity', 'tags', 'title', 'when_made', 'who_made']);
  assert.equal(payload.who_made, 'i_did');
  assert.deepEqual(sent[1], ['image', 555, PNG.length, 'image.png']);
  const receipt = artifactJson(ctx, res.artifactIds[0]);
  assert.equal(receipt.mode, 'etsy_draft');
  assert.equal(receipt.listingId, 555);
  assert.equal(receipt.url, 'https://www.etsy.com/listing/555');
  assert.deepEqual(receipt.images.uploaded, [{ artifact_id: png.artifactIds[0], listing_image_id: 9 }]);
  assert.equal(receipt.images.skipped[0].artifact_id, svgId);
  assert.match(receipt.images.skipped[0].reason, /SVG/);
  assert.equal(receipt.state, 'draft');
  assertBeforeActivation(receipt);
  assert.match(res.output, /Outpost never activates it; before activating in Shop Manager, set Etsy's "How it's made" \/ AI disclosure there \(not in the API\) and rasterize any SVG design/);
});

test('publish_listing sends the declared maker and production partners to Etsy', async () => {
  const sent = [];
  const etsy = {
    configured: true,
    createDraftListing: async (payload) => { sent.push(payload); return { listingId: 556, url: 'https://www.etsy.com/listing/556' }; },
    uploadListingImage: async () => ({ imageId: 1 }),
  };
  const ctx = setup('quill', { connectors: { etsy } });
  const draftId = (await call('create_listing_draft', { ...goodListing(await design(ctx)), who_made: 'someone_else', production_partner_ids: [4021] }, ctx)).artifactIds[0];
  await call('publish_listing', { draft_artifact_id: draftId }, ctx);
  assert.equal(sent[0].who_made, 'someone_else');
  assert.deepEqual(sent[0].production_partner_ids, [4021]);
});

test('package_deliverable records verified sha256 per file and refuses tampered files', async () => {
  const ctx = setup('flux');
  const a = await design(ctx);
  const b = (await call('write_file', { path: 'score.md', content: '# score' }, ctx)).artifactIds[0];
  const res = await call('package_deliverable', { title: 'Order X', artifact_ids: [a, b], notes: 'Order ref: X' }, ctx);
  assert.equal(res.ok, true);
  const manifest = artifactJson(ctx, res.artifactIds[0]);
  assert.equal(ctx.store.state.artifacts[res.artifactIds[0]].kind, 'package');
  assert.deepEqual(manifest.files.map((f) => f.artifact_id), [a, b]);
  for (const f of manifest.files) {
    assert.equal(f.sha256, ctx.store.state.artifacts[f.artifact_id].sha256);
    assert.equal(f.path, ctx.store.state.artifacts[f.artifact_id].path);
  }
  assert.equal(manifest.total_bytes, manifest.files.reduce((n, f) => n + f.bytes, 0));
  assert.match((await call('package_deliverable', { title: 't', artifact_ids: ['art_gone'], notes: '' }, ctx)).output, /unknown artifact/);

  fs.appendFileSync(path.join(ctx.dataDir, ctx.store.state.artifacts[b].path), 'tampered');
  await assert.rejects(() => call('package_deliverable', { title: 't', artifact_ids: [b], notes: '' }, ctx), /integrity/);
});

test('deliver_order writes a manual hand-off sheet and says so', async () => {
  const ctx = setup('flux');
  const a = await design(ctx);
  const pkg = (await call('package_deliverable', { title: 'Order X', artifact_ids: [a], notes: 'n' }, ctx)).artifactIds[0];
  const res = await call('deliver_order', { package_artifact_id: pkg, order_ref: 'FO-123', message: 'Here you go!' }, ctx);
  assert.equal(res.ok, true);
  assert.match(res.output, /Manual delivery required: Fiverr has no seller API/);
  const sheet = artifactJson(ctx, res.artifactIds[0]);
  assert.equal(ctx.store.state.artifacts[res.artifactIds[0]].kind, 'delivery');
  assert.equal(sheet.order_ref, 'FO-123');
  assert.equal(sheet.message_to_buyer, 'Here you go!');
  assert.equal(sheet.status, 'manual delivery required: Fiverr has no seller API');
  assert.deepEqual(sheet.files.map((f) => [f.artifact_id, f.path, f.sha256]), [[a, ctx.store.state.artifacts[a].path, ctx.store.state.artifacts[a].sha256]]);
  await assert.rejects(() => call('deliver_order', { package_artifact_id: a, order_ref: 'x', message: 'm' }, ctx), /not a package/);
});

// ---------------------------------------------------------------------------------------------
// Ledger

function seedLedger(store) {
  const entry = (entryId, kind, amountCents, provenance, source, stream = 'etsy') =>
    store.append('ledger.entry', { entryId, kind, amountCents, currency: 'USD', stream, provenance, source, occurredAt: '2026-09-01T00:00:00.000Z' });
  entry('l1', 'revenue', 3000, 'connector', { connector: 'etsy', externalId: 'receipt:1' });
  entry('l2', 'revenue', 1000, 'manual', { note: 'cash' }, 'fiverr');
  entry('l3', 'revenue', 99900, 'agent_claim', { note: 'I think' });
  entry('l4', 'fee', 300, 'manual', { note: 'fee' });
}

test('read_ledger reports counted totals by provenance and keeps claims out of them', async () => {
  const ctx = setup('tally');
  seedLedger(ctx.store);
  ctx.store.append('spend.recorded', { agentId: 'pixel', category: 'image', model: 'gpt-image-2', usd: 0.25 });
  const { ok, output } = await call('read_ledger', {}, ctx);
  assert.equal(ok, true);
  assert.equal(output.totals.verified_revenue_usd, 30);
  assert.equal(output.totals.operator_revenue_usd, 10);
  assert.equal(output.totals.claimed_revenue_usd, 999);
  assert.equal(output.totals.net_counted_usd, 37);
  assert.equal(output.evidence_coverage, 0.75);
  assert.equal(output.by_stream.etsy.verified_revenue_usd, 30);
  assert.equal(output.by_stream.fiverr.operator_revenue_usd, 10);
  assert.equal(output.runtime_spend_usd.total, 0.25);
  assert.equal(output.runtime_spend_usd.today, 0.25);
  assert.match(output.note, /Agent claims .* never added to any total/);
});

test('read_ledger keeps other currencies out of the *_usd totals and never rounds coverage up (TL-2, TL-14)', async () => {
  const ctx = setup('tally');
  const entry = (entryId, kind, amountCents, provenance, extra = {}) => ctx.store.append('ledger.entry', {
    entryId, kind, amountCents, currency: 'USD', stream: 'etsy', provenance, source: {}, occurredAt: '2026-10-01T00:00:00.000Z', ...extra,
  });
  entry('led_1', 'revenue', 99_960, 'connector', { source: { connector: 'etsy', externalId: 'receipt:1' } });
  entry('led_2', 'revenue', 40, 'manual');
  entry('led_3', 'revenue', 10_000, 'connector', { currency: 'GBP', source: { connector: 'etsy', externalId: 'receipt:2' } });
  entry('led_4', 'fee', 650, 'connector', { currency: 'GBP', source: { connector: 'etsy', externalId: 'ledger:9' } });
  const { output } = await call('read_ledger', {}, ctx);
  assert.equal(output.totals.verified_revenue_usd, 999.6, 'GBP is not added to the USD total');
  assert.equal(output.totals.fees_usd, 0);
  assert.equal(output.evidence_coverage, 0.999, '0.9996 is floored, never rounded up to 1');
  assert.deepEqual(output.unconverted, { GBP: { entries: 2, verified_revenue: 100, operator_revenue: 0, claimed_revenue: 0, fees: 6.5, costs: 0 } });
  assert.match(output.unconverted_note, /NOT in any \*_usd total/);

  entry('led_5', 'refund', 500_000, 'manual');
  const after = (await call('read_ledger', {}, ctx)).output;
  assert.ok(after.evidence_coverage <= 1);
  assert.match(after.evidence_coverage_note, /operator refunds exceed operator revenue/);
});

test('the publish approval says what granting will do: Etsy draft or dry run (TL-6)', () => {
  const tool = TOOLS.publish_listing;
  const off = tool.summarize({ draft_artifact_id: 'art_1' }, { connectors: { etsy: { configured: false } } });
  assert.match(off, /^DRY RUN: nothing will be sent \(no Etsy connector configured\)/);
  const on = tool.summarize({ draft_artifact_id: 'art_1' }, { connectors: { etsy: { configured: true } } });
  assert.match(on, /^WILL CREATE an Etsy DRAFT listing from art_1 via the Etsy API/);
  assert.doesNotMatch(`${off} ${on}`, /if connected/, 'no hedge the runtime could have resolved');
  assert.match(TOOLS.deliver_order.summarize({ package_artifact_id: 'p', order_ref: 'o' }), /nothing is sent/);
});

test('record_ledger_claim appends an agent_claim with its source', async () => {
  const ctx = setup('tally');
  const res = await call('record_ledger_claim', { kind: 'revenue', amount_usd: 19.999, stream: 'fiverr', memo: 'order 7', source_note: 'buyer message in Fiverr inbox' }, ctx);
  assert.equal(res.ok, true);
  assert.match(res.output, /excluded from all counted totals/);
  const [ev] = ofType(ctx, 'ledger.entry');
  assert.equal(ev.actor, 'tally');
  assert.equal(ev.payload.provenance, 'agent_claim');
  assert.equal(ev.payload.amountCents, 2000);
  assert.deepEqual(ev.payload.source, { note: 'buyer message in Fiverr inbox' });
  assert.equal(ctx.store.state.ledger.totals.claimedRevenueCents, 2000);
  assert.equal(ctx.store.state.ledger.totals.verifiedRevenueCents + ctx.store.state.ledger.totals.operatorRevenueCents, 0);
  assert.match(validateInput(TOOLS.record_ledger_claim, { kind: 'fee', amount_usd: 0.004, stream: 's', memo: 'm', source_note: 'n' }), /at least 0.01/);
  assert.equal((await TOOLS.record_ledger_claim.run({ kind: 'fee', amount_usd: 0.004, stream: 's', memo: 'm', source_note: 'n' }, ctx)).ok, false);
  assert.equal((await call('record_ledger_claim', { kind: 'fee', amount_usd: 1, stream: 's', memo: 'm', source_note: '  ' }, ctx)).ok, false);
});

test('sync_connector: unconfigured, success and failure', async () => {
  const unconfigured = await call('sync_connector', { connector: 'etsy' }, setup('tally'));
  assert.equal(unconfigured.ok, false);
  for (const name of ['ETSY_API_KEY', 'ETSY_SHARED_SECRET', 'ETSY_ACCESS_TOKEN', 'ETSY_SHOP_ID']) assert.ok(unconfigured.output.includes(name));
  const ok = await call('sync_connector', { connector: 'etsy' }, setup('tally', { connectors: { etsy: { configured: true, syncRevenue: async () => ({ fetched: 4, newEntries: 1 }) } } }));
  assert.equal(ok.ok, true);
  assert.match(ok.output, /receipts: 4 fetched, 1 new verified entry/);
  const failed = await call('sync_connector', { connector: 'etsy' }, setup('tally', { connectors: { etsy: { configured: true, syncRevenue: async () => { throw new Error('HTTP 503'); } } } }));
  assert.equal(failed.ok, false);
  assert.match(failed.output, /HTTP 503/);
});

// ---------------------------------------------------------------------------------------------
// Coordination

test('delegate_task routes through the dispatcher with the parent task', async () => {
  const ctx = setup('orion');
  const brief = (await call('write_file', { path: 'b.md', content: 'x' }, setup('nova', { store: ctx.store, dataDir: ctx.dataDir }))).artifactIds[0];
  const res = await call('delegate_task', { agent_id: 'pixel', title: 'Design', brief: 'Do it', artifact_ids: [brief] }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.output.task_id, 'task_child');
  assert.deepEqual(res.output.route, ['h-bridge-production']);
  assert.deepEqual(ctx.dispatcher.calls, [['delegate', { fromAgent: 'orion', toAgent: 'pixel', title: 'Design', brief: 'Do it', artifactIds: [brief], parentTaskId: 'task_1' }]]);

  assert.match((await call('delegate_task', { agent_id: 'pixel', title: 't', brief: 'b', artifact_ids: ['art_nope'] }, ctx)).output, /unknown artifact/);
  assert.match((await call('delegate_task', { agent_id: 'ghost', title: 't', brief: 'b', artifact_ids: [] }, ctx)).output, /unknown agent/);
  const nova = setup('nova');
  assert.match((await call('delegate_task', { agent_id: 'pixel', title: 't', brief: 'b', artifact_ids: [] }, nova)).output, /no command console/);
  assert.equal(nova.dispatcher.calls.length, 0);
  const declined = setup('orion', { dispatcher: fakeDispatcher({ ok: false, reason: 'E-STOP engaged' }) });
  assert.match((await call('delegate_task', { agent_id: 'nova', title: 't', brief: 'b', artifact_ids: [] }, declined)).output, /E-STOP engaged/);
});

test('handoff follows hallway lanes', async () => {
  const ctx = setup('nova');
  const ok = await call('handoff', { agent_id: 'pixel', title: 'Design this', brief: 'b', artifact_ids: [] }, ctx);
  assert.equal(ok.ok, true);
  assert.deepEqual(ctx.dispatcher.calls[0], ['handoff', { fromAgent: 'nova', toAgent: 'pixel', title: 'Design this', brief: 'b', artifactIds: [], parentTaskId: 'task_1' }]);
  const same = await call('handoff', { agent_id: 'vega', title: 't', brief: 'b', artifact_ids: [] }, ctx);
  assert.deepEqual(same.output.route, []);
  const far = await call('handoff', { agent_id: 'flux', title: 't', brief: 'b', artifact_ids: [] }, ctx);
  assert.equal(far.ok, false);
  assert.match(far.output, /no direct lane/);
  assert.equal(ctx.dispatcher.calls.length, 2);
});

test('list_tasks lists newest first and filters by status', async () => {
  const ctx = setup('orion');
  ctx.store.append('task.created', { taskId: 'task_2', title: 'Second', brief: 'b', assignee: 'nova', createdBy: 'orion', parentTaskId: 'task_1' });
  ctx.store.append('task.status', { taskId: 'task_2', status: 'done', outputs: ['art_1'], summary: 'did it' });
  const all = await call('list_tasks', { status: null }, ctx);
  assert.deepEqual(all.output.tasks.map((t) => t.task_id), ['task_2', 'task_1']);
  assert.deepEqual(all.output.tasks[0], { task_id: 'task_2', title: 'Second', assignee: 'nova', status: 'done', kind: 'work', created_by: 'orion', parent_task_id: 'task_1', outputs: ['art_1'], summary: 'did it', reason: '' });
  const done = await call('list_tasks', { status: 'done' }, ctx);
  assert.deepEqual(done.output.tasks.map((t) => t.task_id), ['task_2']);
});
