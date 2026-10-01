import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload } from '../shared/events.js';
import { FEED_LIMIT, anthropicStatus, apply, coverageCaveat, describe, evidenceCoverage, initialState, netCents, project } from '../shared/projector.js';

const TS = '2026-10-01T10:00:00.000Z';

/** Build a sequence of valid events: each spec is [type, payload, ts?]. */
function events(specs) {
  return specs.map(([type, payload, ts = TS], i) => {
    const err = validatePayload(type, payload);
    assert.equal(err, null, err);
    return { seq: i + 1, ts, type, actor: 'system', payload };
  });
}

let entry = 0;
function ledger(kind, cents, provenance, extra = {}) {
  entry += 1;
  return ['ledger.entry', {
    entryId: extra.entryId || `led_${entry}`,
    kind,
    amountCents: cents,
    currency: extra.currency || 'USD',
    stream: extra.stream || 'etsy',
    provenance,
    source: extra.source || {},
    occurredAt: TS,
  }];
}

test('agent claims are displayed but never counted', () => {
  const s = project(events([
    ledger('revenue', 1000, 'connector', { source: { connector: 'etsy', externalId: 'receipt:1' } }),
    ledger('revenue', 500, 'manual', { stream: 'fiverr' }),
    ledger('revenue', 999_999, 'agent_claim'),
  ]));
  const t = s.ledger.totals;
  assert.equal(t.verifiedRevenueCents, 1000);
  assert.equal(t.operatorRevenueCents, 500);
  assert.equal(t.claimedRevenueCents, 999_999);
  assert.equal(t.verifiedOrders, 1);
  assert.equal(t.operatorOrders, 1);
  assert.equal(netCents(t), 1500);
  assert.equal(s.ledger.entryOrder.length, 3);
  assert.equal(s.ledger.byStream.etsy.verifiedRevenueCents, 1000);
  assert.equal(s.ledger.byStream.etsy.claimedRevenueCents, 999_999);
  assert.equal(s.ledger.byStream.fiverr.operatorRevenueCents, 500);
});

test('connector entries are deduplicated by externalId', () => {
  const src = { connector: 'etsy', externalId: 'receipt:42' };
  const s = project(events([
    ledger('revenue', 2500, 'connector', { source: src }),
    ledger('revenue', 2500, 'connector', { source: src }), // re-sync, new entryId, same receipt
    ledger('revenue', 2500, 'connector', { source: { connector: 'etsy', externalId: 'receipt:43' } }),
  ]));
  assert.equal(s.ledger.totals.verifiedRevenueCents, 5000);
  assert.equal(s.ledger.totals.verifiedOrders, 2);
  assert.equal(s.ledger.entryOrder.length, 2);
  assert.ok(s.ledger.externalIds['etsy:receipt:42']);
});

test('a repeated entryId is counted once', () => {
  const s = project(events([
    ledger('revenue', 700, 'manual', { entryId: 'led_same' }),
    ledger('revenue', 700, 'manual', { entryId: 'led_same' }),
  ]));
  assert.equal(s.ledger.totals.operatorRevenueCents, 700);
});

test('refunds subtract; fees and costs reduce net', () => {
  const s = project(events([
    ledger('revenue', 2000, 'connector', { source: { connector: 'etsy', externalId: 'receipt:1' } }),
    ledger('refund', 500, 'connector', { source: { connector: 'etsy', externalId: 'refund:1' } }),
    ledger('revenue', 1000, 'manual'),
    ledger('refund', 250, 'manual'),
    ledger('revenue', 300, 'agent_claim'),
    ledger('refund', 100, 'agent_claim'),
    ledger('fee', 120, 'connector', { source: { connector: 'etsy', externalId: 'fee:1' } }),
    ledger('cost', 80, 'manual'),
  ]));
  const t = s.ledger.totals;
  assert.equal(t.verifiedRevenueCents, 1500);
  assert.equal(t.operatorRevenueCents, 750);
  assert.equal(t.claimedRevenueCents, 200);
  assert.equal(t.verifiedOrders, 1, 'refunds are not orders');
  assert.equal(t.feesCents, 120);
  assert.equal(t.costCents, 80);
  assert.equal(netCents(t), 1500 + 750 - 120 - 80);
});

test('evidenceCoverage is the connector-backed share of counted revenue', () => {
  assert.equal(evidenceCoverage(initialState().ledger.totals), null);
  const claimsOnly = project(events([ledger('revenue', 5000, 'agent_claim')]));
  assert.equal(evidenceCoverage(claimsOnly.ledger.totals), null, 'claims are not evidence');
  const mixed = project(events([
    ledger('revenue', 3000, 'connector', { source: { connector: 'etsy', externalId: 'receipt:9' } }),
    ledger('revenue', 1000, 'manual'),
    ledger('revenue', 9000, 'agent_claim'),
  ]));
  assert.equal(evidenceCoverage(mixed.ledger.totals), 0.75);
});

test('replay is idempotent: re-applying events changes nothing', () => {
  const log = events([
    ['station.loaded', { station: { rooms: [], hallways: [], agents: [{ id: 'nova', room: 'research' }] } }],
    ['task.created', { taskId: 't1', title: 'Scan', brief: 'b', assignee: 'nova', createdBy: 'operator' }],
    ['run.started', { runId: 'r1', taskId: 't1', agentId: 'nova', provider: 'scripted', model: 'scripted', tools: [] }],
    ['run.step', { runId: 'r1', agentId: 'nova', turn: 1, stopReason: 'end_turn', usage: {}, costUsd: 0.5, text: 'done' }],
    ledger('revenue', 1000, 'connector', { source: { connector: 'etsy', externalId: 'receipt:1' } }),
  ]);
  const once = project(log);
  const snapshot = structuredClone(once);
  project(log, once);
  for (const e of log) apply(once, e);
  assert.deepEqual(once, snapshot);
  assert.equal(once.spend.totalUsd, 0.5);
  assert.deepEqual(once.tasks.t1.runIds, ['r1']);
});

test('spend is bucketed by UTC day, agent and model; tool spend joins its run', () => {
  const s = project(events([
    ['run.started', { runId: 'r1', taskId: 't1', agentId: 'pixel', provider: 'anthropic', model: 'claude-opus-5-5', tools: [] }, '2026-09-30T23:59:59.000Z'],
    ['run.step', { runId: 'r1', agentId: 'pixel', turn: 1, stopReason: 'tool_use', usage: {}, costUsd: 0.25 }, '2026-09-30T23:59:59.500Z'],
    ['spend.recorded', { agentId: 'pixel', runId: 'r1', category: 'image', model: 'gpt-image-1', usd: 0.04 }, '2026-10-01T00:00:01.000Z'],
    ['run.step', { runId: 'r1', agentId: 'pixel', turn: 2, stopReason: 'end_turn', usage: {}, costUsd: 0.5 }, '2026-10-01T00:00:02.000Z'],
  ]));
  assert.deepEqual(Object.keys(s.spend.byDay).sort(), ['2026-09-30', '2026-10-01']);
  assert.equal(s.spend.byDay['2026-09-30'], 0.25);
  assert.equal(s.spend.byDay['2026-10-01'], 0.54);
  assert.equal(s.spend.byModel['claude-opus-5-5'], 0.75);
  assert.equal(s.spend.byModel['gpt-image-1'], 0.04);
  assert.equal(s.spend.byAgent.pixel, 0.79);
  assert.equal(s.spend.steps, 2);
  assert.equal(s.runs.r1.costUsd, 0.79);
  assert.equal(s.runs.r1.turns, 2);
});

test('the feed is capped and skips silent run steps', () => {
  const specs = [];
  for (let i = 0; i < FEED_LIMIT + 50; i++) specs.push(['log', { level: 'info', message: `m${i}` }]);
  specs.push(['run.step', { runId: 'r', agentId: 'a', turn: 1, stopReason: 'tool_use', usage: {}, costUsd: 0 }]);
  const s = project(events(specs));
  assert.equal(s.feed.length, FEED_LIMIT);
  assert.equal(s.feed[0].seq, 51);
  assert.equal(s.feed.at(-1).text, `m${FEED_LIMIT + 49}`);
});

// ---- evidence coverage stays a share (TL-1) ---------------------------------------------------

const etsyRevenue = (cents, id = 'receipt:1') => ledger('revenue', cents, 'connector', { source: { connector: 'etsy', externalId: id } });

test('evidence coverage never exceeds 100% when operator refunds outweigh operator revenue', () => {
  const s = project(events([etsyRevenue(10_000), ledger('refund', 6000, 'manual')]));
  const t = s.ledger.totals;
  assert.equal(t.operatorRevenueCents, -6000, 'net meaning is unchanged');
  assert.equal(t.operatorRefundCents, 6000);
  assert.equal(netCents(t), 4000);
  const cov = evidenceCoverage(t);
  assert.ok(cov !== null && cov >= 0 && cov <= 1, `coverage ${cov} must be within [0, 1]`);
  assert.equal(coverageCaveat(t), 'operator refunds exceed operator revenue');
});

test('verified revenue with operator refunds exceeding everything still has a coverage, never "nothing counted"', () => {
  const s = project(events([etsyRevenue(10_000), ledger('refund', 15_000, 'manual')]));
  const t = s.ledger.totals;
  assert.equal(evidenceCoverage(t), 1, 'all positive counted revenue is verified');
  assert.equal(coverageCaveat(t), 'operator refunds exceed operator revenue');
  const mixed = project(events([etsyRevenue(9950), ledger('revenue', 50, 'manual')]));
  assert.equal(evidenceCoverage(mixed.ledger.totals), 0.995);
  assert.equal(coverageCaveat(mixed.ledger.totals), null);
  for (const [v, o] of [[0, 0], [-500, 0], [0, -500]]) {
    assert.equal(evidenceCoverage({ verifiedRevenueCents: v, operatorRevenueCents: o }), null, `${v}/${o}`);
  }
  const refunds = project(events([etsyRevenue(2000), ledger('refund', 500, 'connector', { source: { connector: 'etsy', externalId: 'refund:1' } })]));
  assert.equal(refunds.ledger.totals.verifiedRefundCents, 500);
  assert.equal(refunds.ledger.totals.verifiedRevenueCents, 1500);
});

// ---- currencies are never summed (TL-2) -----------------------------------------------------------

test('entries in another currency are kept out of the USD totals and tallied per currency', () => {
  const s = project(events([
    ledger('revenue', 10_000, 'connector', { currency: 'GBP', source: { connector: 'etsy', externalId: 'receipt:555' } }),
    ledger('fee', 650, 'connector', { currency: 'GBP', source: { connector: 'etsy', externalId: 'ledger:9' } }),
    ledger('revenue', 2000, 'manual', { stream: 'fiverr' }),
  ]));
  const L = s.ledger;
  assert.equal(L.totals.verifiedRevenueCents, 0, 'GBP is not dollars');
  assert.equal(L.totals.feesCents, 0);
  assert.equal(L.totals.operatorRevenueCents, 2000);
  assert.equal(L.byStream.etsy, undefined, 'no USD figure for the GBP-only stream');
  assert.deepEqual(
    { entries: L.unconverted.GBP.entries, verified: L.unconverted.GBP.verifiedRevenueCents, fees: L.unconverted.GBP.feesCents },
    { entries: 2, verified: 10_000, fees: 650 },
  );
  assert.equal(L.entryOrder.length, 3, 'nothing is dropped from the entry list');
  assert.ok(L.externalIds['etsy:receipt:555'], 'dedup still applies');
  assert.match(s.feed.find((f) => f.type === 'ledger.entry').text, /^Ledger revenue 100\.00 GBP etsy \[connector\]$/);
  assert.match(s.feed.at(-1).text, /^Ledger revenue \$20\.00 fiverr \[manual\]$/);
});

// ---- feed wording (TL-12, TL-13) ------------------------------------------------------------------

test('a dispatcher-routed handoff is not described as an agent handing work over', () => {
  const p = { handoffId: 'h1', fromAgent: 'nova', toAgent: 'pixel', fromRoom: 'research', toRoom: 'production', route: ['hw'], taskId: 't9', artifactIds: [] };
  assert.equal(describe({ type: 'handoff', actor: 'system', payload: p }), "Dispatcher routed nova's outputs to pixel for task t9 (research → production)");
  assert.equal(describe({ type: 'handoff', actor: 'nova', payload: p }), 'nova handed task t9 to pixel (research → production)');
});

test('an Etsy sync is described per record kind, never "2 new of 1"', () => {
  const full = { connector: 'etsy', ok: true, fetched: 1, newEntries: 2, receipts: { fetched: 1, newEntries: 1 }, fees: { fetched: 1, newEntries: 1, feeLines: 1 } };
  assert.equal(describe({ type: 'connector.sync', actor: 'connector:etsy', payload: full }), 'etsy sync: receipts 1 new of 1, fees 1 new of 1 ledger lines');
  const s = project(events([['connector.sync', full]]));
  assert.deepEqual([s.connectors.etsy.receipts, s.connectors.etsy.fees], [{ fetched: 1, newEntries: 1 }, { fetched: 1, newEntries: 1 }]);
  assert.equal(describe({ type: 'connector.sync', actor: 'x', payload: { connector: 'etsy', ok: true, fetched: 3, newEntries: 1 } }), 'etsy sync: 1 new of 3');
});

// ---- provider proof, scripted steps, schedules (TL-7, TL-5, RT-7) -------------------------------------

test('anthropicStatus: a key is unverified until a run.step, and an auth failure is reported', () => {
  const started = (runId) => ['run.started', { runId, taskId: 't1', agentId: 'tally', provider: 'anthropic', model: 'claude-opus-5-5', tools: [] }];
  const failed = (runId, error) => ['run.finished', { runId, agentId: 'tally', taskId: 't1', outcome: 'failed', turns: 0, costUsd: 0, error }];
  assert.equal(anthropicStatus(initialState()).status, 'unverified');
  const authFail = project(events([started('r1'), failed('r1', 'AuthenticationError: 401 {"message":"invalid x-api-key"}')]));
  assert.deepEqual(anthropicStatus(authFail), { status: 'auth_failed', runId: 'r1', error: 'AuthenticationError: 401 {"message":"invalid x-api-key"}' });
  const ok = project(events([started('r1'), failed('r1', 'AuthenticationError: 401'), started('r2'), ['run.step', { runId: 'r2', agentId: 'tally', turn: 1, stopReason: 'end_turn', usage: {}, costUsd: 0.01 }]]));
  assert.deepEqual(anthropicStatus(ok), { status: 'verified', runId: 'r2' });
  const overloaded = project(events([started('r1'), failed('r1', 'OverloadedError: 529 overloaded')]));
  assert.equal(anthropicStatus(overloaded).status, 'unverified', 'a non-auth failure proves nothing either way');
});

test('scripted steps are counted apart, and a schedule remembers the tasks of its last firing', () => {
  const s = project(events([
    ['run.started', { runId: 'r1', taskId: 't1', agentId: 'nova', provider: 'scripted', model: 'scripted', tools: [] }],
    ['run.step', { runId: 'r1', agentId: 'nova', turn: 1, stopReason: 'end_turn', usage: {}, costUsd: 0 }],
    ['schedule.created', { scheduleId: 's1', spec: 'every 5m', template: { recipe: 'ledger_report' }, enabled: true }],
    ['schedule.fired', { scheduleId: 's1', taskIds: ['t7', 't8'] }],
  ]));
  assert.deepEqual([s.spend.steps, s.spend.scriptedSteps], [1, 1]);
  assert.deepEqual(s.schedules.s1.lastTaskIds, ['t7', 't8']);
});
