import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload } from '../shared/events.js';
import { FEED_LIMIT, apply, evidenceCoverage, initialState, netCents, project } from '../shared/projector.js';

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
    currency: 'USD',
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
