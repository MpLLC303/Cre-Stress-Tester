import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canDelegate, canHandoff, checkCall, route, toolsForAgent, validateStation } from '../sidecar/capability.js';

const station = JSON.parse(fs.readFileSync(new URL('../config/station.json', import.meta.url), 'utf8'));
const tools = (agentId) => toolsForAgent(station, agentId).map((g) => g.tool);
const grant = (agentId, tool) => toolsForAgent(station, agentId).find((g) => g.tool === tool);

test('the default layout is structurally valid', () => {
  assert.deepEqual(validateStation(station), []);
});

test('research lab: nova can search but cannot publish or touch money', () => {
  assert.equal(grant('nova', 'web_search').objectId, 'research-terminal');
  assert.ok(tools('nova').includes('web_fetch'));
  assert.ok(tools('nova').includes('memory_write'));
  for (const t of ['publish_listing', 'record_ledger_claim', 'delegate_task', 'render_svg_design']) {
    assert.ok(!tools('nova').includes(t), t);
  }
  const denied = checkCall(station, 'nova', 'publish_listing');
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /Research Lab/);
});

test('production bay grants design, listing and the publish gate; tools map to the first granting object', () => {
  assert.equal(grant('pixel', 'render_svg_design').objectId, 'prod-design');
  assert.equal(grant('pixel', 'read_artifact').objectId, 'prod-design');
  assert.equal(grant('quill', 'create_listing_draft').objectId, 'prod-composer');
  assert.deepEqual(checkCall(station, 'quill', 'publish_listing'), { ok: true, objectId: 'prod-gate', reason: '' });
  assert.ok(!tools('pixel').includes('web_search'));
});

test('bridge: orion can delegate and read the ledger but has no workbench', () => {
  assert.equal(grant('orion', 'delegate_task').objectId, 'bridge-console');
  assert.ok(tools('orion').includes('read_ledger'));
  assert.ok(!tools('orion').includes('write_file'));
  assert.equal(checkCall(station, 'pixel', 'delegate_task').ok, false);
});

test('output studio and ops grants', () => {
  assert.ok(tools('flux').includes('deliver_order'));
  assert.ok(tools('flux').includes('package_deliverable'));
  assert.ok(tools('tally').includes('record_ledger_claim'));
  assert.ok(tools('tally').includes('sync_connector'));
  assert.ok(!tools('tally').includes('write_file'));
  assert.ok(!tools('tally').includes('create_listing_draft'));
});

test('handoff is intrinsic, with no object behind it', () => {
  assert.deepEqual(grant('tally', 'handoff'), { tool: 'handoff', objectId: null });
  const isolated = structuredClone(station);
  isolated.hallways = isolated.hallways.filter((h) => h.a !== 'ops' && h.b !== 'ops');
  assert.ok(!toolsForAgent(isolated, 'tally').some((g) => g.tool === 'handoff'), 'alone with no lane: no handoff');
  assert.deepEqual(toolsForAgent(station, 'ghost'), []);
});

test('canHandoff: same room or exactly one hallway', () => {
  assert.deepEqual(canHandoff(station, 'pixel', 'quill'), { ok: true, route: [], reason: '' });
  assert.deepEqual(canHandoff(station, 'pixel', 'nova'), { ok: true, route: ['h-research-production'], reason: '' });
  const far = canHandoff(station, 'pixel', 'tally');
  assert.equal(far.ok, false);
  assert.deepEqual(far.route, ['h-bridge-production', 'h-bridge-ops']);
  assert.match(far.reason, /commander/);
  assert.equal(canHandoff(station, 'pixel', 'pixel').ok, false);
  assert.match(canHandoff(station, 'pixel', 'ghost').reason, /unknown agent ghost/);
});

test('route() finds the shortest hallway path', () => {
  assert.deepEqual(route(station, 'research', 'research'), []);
  assert.deepEqual(route(station, 'research', 'production'), ['h-research-production']);
  assert.deepEqual(route(station, 'production', 'research'), ['h-research-production']);
  assert.deepEqual(route(station, 'research', 'ops'), ['h-research-bridge', 'h-bridge-ops']);
  assert.equal(route(station, 'output', 'ops').length, 2);
  const cut = structuredClone(station);
  cut.hallways = cut.hallways.filter((h) => h.id !== 'h-bridge-ops');
  assert.equal(route(cut, 'research', 'ops'), null);
});

test('canDelegate: only the bridge delegates, to any reachable room', () => {
  assert.deepEqual(canDelegate(station, 'orion', 'tally'), { ok: true, route: ['h-bridge-ops'], reason: '' });
  assert.equal(canDelegate(station, 'orion', 'nova').ok, true);
  const denied = canDelegate(station, 'nova', 'pixel');
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /command console/);
  const cut = structuredClone(station);
  cut.hallways = cut.hallways.filter((h) => h.id !== 'h-bridge-ops');
  assert.match(canDelegate(cut, 'orion', 'tally').reason, /unreachable/);
});

test('validateStation reports broken layouts', () => {
  const broken = structuredClone(station);
  broken.agents.push({ ...broken.agents[0], room: 'nowhere' });
  broken.hallways.push({ id: 'h-x', a: 'bridge', b: 'void' });
  broken.rooms[0].objects.push({ id: 'odd', type: 'teleporter', at: [0, 0] });
  const problems = validateStation(broken);
  assert.ok(problems.some((p) => /unknown room nowhere/.test(p)));
  assert.ok(problems.some((p) => /hallway h-x/.test(p)));
  assert.ok(problems.some((p) => /unknown type teleporter/.test(p)));
  assert.ok(problems.includes('duplicate agent ids'));
});
