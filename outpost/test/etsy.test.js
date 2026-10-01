import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../sidecar/store.js';
import { netCents } from '../shared/projector.js';
import {
  createEtsyConnector, receiptEntries, recordedReceipts, ledgerFeeEntry, ledgerFees, ETSY_API_BASE, ETSY_FEE_LEDGER_TYPES,
} from '../sidecar/connectors/etsy.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-'));
const CREDS = { apiKey: 'KEYSTRING', sharedSecret: 'SHAREDSECRET', accessToken: '123.TOKEN', shopId: '777' };
const usd = (cents) => ({ amount: cents, divisor: 100, currency_code: 'USD' });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png')]);
const NOW_S = 1_790_000_000;
const now = () => NOW_S * 1000;
const DAY = 86_400;
const LEDGER_PATH = '/payment-account/ledger-entries';

function receipt(id, { items = 2000, shipping = 500, discount = 200, tax = 160, vat = 0, paid = true, status, refunds = [], created = 1_780_000_000 } = {}) {
  return {
    receipt_id: id,
    is_paid: paid,
    status: status ?? (paid ? 'paid' : 'open'),
    create_timestamp: created,
    update_timestamp: created + 60,
    total_price: usd(items),
    subtotal: usd(items - discount), // Etsy: total_price minus coupon discounts
    total_shipping_cost: usd(shipping),
    discount_amt: usd(discount),
    total_tax_cost: usd(tax),
    total_vat_cost: usd(vat),
    grandtotal: usd(items - discount + shipping + tax + vat),
    refunds,
  };
}

/** A payment-account ledger line as getShopPaymentAccountLedgerEntries returns it. */
function line(id, type, amount, { at = NOW_S - 3600, currency = 'USD', ...extra } = {}) {
  return {
    entry_id: id, ledger_id: 9, sequence_number: id, amount, currency, description: type, balance: 0,
    create_date: at, created_timestamp: at, ledger_type: type, reference_type: 'receipt', reference_id: '42', ...extra,
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status });

/**
 * A fake Etsy: receipts and ledger lines with offset/limit paging (ledger lines filtered by the
 * required min_created/max_created window). Records every request.
 */
function fakeEtsy(receipts = [], { ledger = [], failWith, ledgerFail } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    requests.push({ url: u, init });
    if (failWith) return json(failWith.status, { error: failWith.error });
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset'));
    if (u.pathname.endsWith(LEDGER_PATH)) {
      if (ledgerFail) return json(ledgerFail.status, { error: ledgerFail.error });
      const min = Number(u.searchParams.get('min_created'));
      const max = Number(u.searchParams.get('max_created'));
      const inWindow = ledger.filter((e) => e.created_timestamp >= min && e.created_timestamp <= max);
      return json(200, { count: inWindow.length, results: inWindow.slice(offset, offset + limit) });
    }
    return json(200, { count: receipts.length, results: receipts.slice(offset, offset + limit) });
  };
  const of = (suffix) => () => requests.filter((r) => r.url.pathname.endsWith(suffix));
  return { requests, fetchImpl, receiptRequests: of('/receipts'), ledgerRequests: of(LEDGER_PATH) };
}

function openStore() {
  return createStore({ dataDir: tmp() });
}

const syncs = (store) => store.events().filter((e) => e.type === 'connector.sync');

// ---- configuration and requests ---------------------------------------------------------

test('configured needs keystring, shared secret, a token and shop id', () => {
  assert.equal(createEtsyConnector(CREDS).configured, true);
  for (const key of Object.keys(CREDS)) assert.equal(createEtsyConnector({ ...CREDS, [key]: null }).configured, false, key);
  assert.equal(createEtsyConnector().configured, false);
  // a refresh token alone can mint the access token
  assert.equal(createEtsyConnector({ ...CREDS, accessToken: null, refreshToken: '123.REFRESH' }).configured, true);
});

test('requests carry keystring:shared_secret in x-api-key and the bearer token', async () => {
  const etsy = fakeEtsy([receipt(1)]);
  await createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl }).fetchReceipts({ minCreated: 1_700_000_000 });
  const [{ url, init }] = etsy.requests;
  assert.equal(`${url.origin}${url.pathname}`, `${ETSY_API_BASE}/shops/777/receipts`);
  assert.equal(init.method, 'GET');
  assert.equal(init.headers['x-api-key'], 'KEYSTRING:SHAREDSECRET', 'keystring:shared_secret, enforced since 2026-02-09');
  assert.equal(init.headers.authorization, 'Bearer 123.TOKEN');
  assert.equal(url.searchParams.get('min_created'), '1700000000');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('offset'), '0');
});

test('the shared-secret header cites the verified discussion (#1529, not #1521)', () => {
  const source = fs.readFileSync(new URL('../sidecar/connectors/etsy.js', import.meta.url), 'utf8');
  assert.match(source, /github\.com\/etsy\/open-api\/discussions\/1529/);
  assert.doesNotMatch(source, /1521/);
});

test('fetchReceipts pages with limit/offset until the count is reached and clamps limit to 100', async () => {
  const all = [1, 2, 3, 4, 5].map((id) => receipt(id));
  const etsy = fakeEtsy(all);
  const connector = createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl });
  const got = await connector.fetchReceipts({ limit: 2 });
  assert.deepEqual(got.map((r) => r.receipt_id), [1, 2, 3, 4, 5]);
  assert.deepEqual(etsy.requests.map((r) => r.url.searchParams.get('offset')), ['0', '2', '4']);

  const many = Array.from({ length: 230 }, (_, i) => receipt(i + 1));
  const big = fakeEtsy(many);
  const fetched = await createEtsyConnector({ ...CREDS, fetchImpl: big.fetchImpl }).fetchReceipts({ limit: 500 });
  assert.equal(fetched.length, 230);
  assert.deepEqual(big.requests.map((r) => [r.url.searchParams.get('limit'), r.url.searchParams.get('offset')]), [['100', '0'], ['100', '100'], ['100', '200']]);
});

// ---- receipts: revenue and refunds ------------------------------------------------------

test('revenue = items + shipping - discounts; sales tax and VAT are excluded', () => {
  const [entry] = receiptEntries(receipt(42, { items: 2000, shipping: 500, discount: 200, tax: 160, vat: 75 }), '777');
  assert.equal(entry.kind, 'revenue');
  assert.equal(entry.amountCents, 2300);
  assert.equal(entry.currency, 'USD');
  assert.equal(entry.provenance, 'connector');
  assert.deepEqual(entry.source, { connector: 'etsy', externalId: 'receipt:42', url: `${ETSY_API_BASE}/shops/777/receipts/42` });
  assert.equal(entry.occurredAt, new Date(1_780_000_000 * 1000).toISOString());
  assert.deepEqual(receiptEntries(receipt(43, { paid: false }), '777'), []);
  assert.throws(() => receiptEntries({ ...receipt(44), total_shipping_cost: { amount: 1, divisor: 100, currency_code: 'EUR' } }, '777'), /one currency/);
});

test('refunds on a receipt become separate refund entries', () => {
  const entries = receiptEntries(receipt(50, { refunds: [{ amount: usd(700), created_timestamp: 1_780_100_000, reason: 'damaged', status: 'completed' }] }), '777');
  assert.deepEqual(entries.map((e) => [e.kind, e.amountCents]), [['revenue', 2300], ['refund', 700]]);
  assert.equal(entries[1].source.externalId, 'refund:50:1780100000:700');
  assert.match(entries[1].memo, /completed.*damaged/);
});

test('a partially refunded receipt nets revenue minus the refund, not full revenue', async () => {
  const store = openStore();
  const partial = receipt(60, { status: 'partially refunded', refunds: [{ amount: usd(700), created_timestamp: 1_780_100_000, reason: 'one item damaged', status: 'completed' }] });
  const etsy = fakeEtsy([partial, receipt(61, { items: 1000, shipping: 0, discount: 0 })]);
  const result = await createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl, now }).syncRevenue(store);
  assert.deepEqual(result.receipts, { fetched: 2, newEntries: 3 });
  const { totals } = store.state.ledger;
  assert.equal(totals.verifiedRevenueCents, 2300 - 700 + 1000, 'the partial refund is netted out');
  assert.equal(totals.verifiedOrders, 2);
  assert.equal(netCents(totals), 2600);
  assert.equal(store.state.ledger.byStream.etsy.verifiedRevenueCents, 2600);
  store.close();
});

test('fully refunded and canceled receipts net to zero, and refunds never push a receipt below zero', () => {
  // Etsy says "fully refunded" but lists no refund record yet: a balancing refund nets it to zero.
  const full = receiptEntries(receipt(70, { status: 'fully refunded' }), '777');
  assert.deepEqual(full.map((e) => [e.kind, e.amountCents, e.source.externalId]), [['revenue', 2300, 'receipt:70'], ['refund', 2300, 'refund:70:balance']]);
  assert.match(full[1].memo, /fully refunded.*nets to zero/);

  // A refund that includes sales tax (2460 > the 2300 counted) is capped at what the receipt counts.
  const taxed = receiptEntries(receipt(71, { status: 'fully refunded', refunds: [{ amount: usd(2460), created_timestamp: 1_780_100_000 }] }), '777');
  assert.deepEqual(taxed.map((e) => [e.kind, e.amountCents]), [['revenue', 2300], ['refund', 2300]]);
  assert.match(taxed[1].memo, /reported 2460¢; capped/);

  // A partial refund larger than what is left is capped too; there is no balancing entry.
  const over = receiptEntries(receipt(72, { status: 'partially refunded', refunds: [{ amount: usd(2000), created_timestamp: 1 }, { amount: usd(900), created_timestamp: 2 }] }), '777');
  assert.deepEqual(over.map((e) => [e.kind, e.amountCents]), [['revenue', 2300], ['refund', 2000], ['refund', 300]]);

  // Canceled before it was ever counted: nothing to record. Unpaid with refunds: nothing either.
  assert.deepEqual(receiptEntries(receipt(73, { status: 'canceled', refunds: [{ amount: usd(2300), created_timestamp: 5 }] }), '777'), []);
  assert.deepEqual(receiptEntries(receipt(74, { paid: false, refunds: [{ amount: usd(500), created_timestamp: 5 }] }), '777'), []);

  // Canceled after it was counted: the recorded revenue is reversed in full.
  const reversed = receiptEntries(receipt(75, { status: 'canceled', paid: false }), '777', { revenueCents: 2300, currency: 'USD', refundedCents: 0, refundIds: new Set() });
  assert.deepEqual(reversed.map((e) => [e.kind, e.amountCents, e.source.externalId]), [['refund', 2300, 'refund:75:balance']]);
});

test('refund netting holds across syncs: a balance and a late refund record never double-count', async () => {
  const store = openStore();
  const receipts = [receipt(80)];
  const etsy = fakeEtsy(receipts);
  const connector = createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl, now });

  await connector.syncRevenue(store); // paid: counted in full
  assert.equal(store.state.ledger.totals.verifiedRevenueCents, 2300);

  receipts[0] = receipt(80, { status: 'fully refunded' }); // Etsy has not listed the refund yet
  await connector.syncRevenue(store);
  assert.equal(store.state.ledger.totals.verifiedRevenueCents, 0);

  receipts[0] = receipt(80, { status: 'fully refunded', refunds: [{ amount: usd(2460), created_timestamp: 1_780_200_000 }] });
  const late = await connector.syncRevenue(store);
  assert.equal(late.receipts.newEntries, 0, 'the late refund record has nothing left to refund');
  assert.equal(store.state.ledger.totals.verifiedRevenueCents, 0);
  assert.equal(store.state.ledger.totals.verifiedOrders, 1);

  const prior = recordedReceipts(store.state.ledger).get('80');
  assert.equal(prior.revenueCents, 2300);
  assert.equal(prior.refundedCents, 2300);
  assert.deepEqual([...prior.refundIds], ['refund:80:balance']);
  store.close();
});

test('syncRevenue records verified entries once and reports only new ones', async () => {
  const store = openStore();
  const receipts = Array.from({ length: 150 }, (_, i) => receipt(i + 1, { items: 1000, shipping: 0, discount: 0 }));
  receipts.push(receipt(999, { paid: false }));
  const etsy = fakeEtsy(receipts);
  const connector = createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl, now });

  const first = await connector.syncRevenue(store);
  assert.deepEqual([first.fetched, first.newEntries, first.receipts], [151, 150, { fetched: 151, newEntries: 150 }]);
  assert.equal(etsy.receiptRequests().length, 2);
  assert.equal(etsy.ledgerRequests().length, 1, 'fees are read in the same sync');
  assert.equal(store.state.ledger.totals.verifiedRevenueCents, 150_000);
  assert.equal(store.state.ledger.totals.verifiedOrders, 150);
  assert.deepEqual(syncs(store)[0].payload, { connector: 'etsy', ok: true, ...first });
  assert.equal(syncs(store)[0].actor, 'connector:etsy');

  receipts.push(receipt(151, { items: 4000, shipping: 0, discount: 0 }));
  const before = store.state.ledger.entryOrder.length;
  const second = await connector.syncRevenue(store);
  assert.deepEqual([second.fetched, second.newEntries], [152, 1]);
  assert.equal(store.state.ledger.entryOrder.length, before + 1);
  assert.equal(store.state.ledger.totals.verifiedRevenueCents, 154_000);
  assert.deepEqual([syncs(store)[1].payload.fetched, syncs(store)[1].payload.newEntries], [152, 1]);
  assert.equal(connector.sync, connector.syncRevenue, 'sync() is the full receipts + fees sync');
  store.close();
});

test('an HTTP error emits connector.sync ok:false without leaking credentials', async () => {
  const store = openStore();
  const etsy = fakeEtsy([], { failWith: { status: 403, error: 'Invalid API key: KEYSTRING:SHAREDSECRET' } });
  const connector = createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl, now });
  await assert.rejects(() => connector.syncRevenue(store), (err) => /HTTP 403/.test(err.message) && !/KEYSTRING|SHAREDSECRET/.test(err.message));
  const [sync] = syncs(store);
  assert.equal(sync.payload.ok, false);
  assert.equal(sync.payload.newEntries, 0);
  assert.match(sync.payload.error, /HTTP 403/);
  assert.doesNotMatch(JSON.stringify(store.events()), /KEYSTRING|SHAREDSECRET|TOKEN/);
  assert.equal(store.state.connectors.etsy.ok, false);
  assert.equal(store.state.ledger.entryOrder.length, 0);
  store.close();
});

test('a malformed receipt fails the whole sync before anything is recorded', async () => {
  const store = openStore();
  const bad = { ...receipt(2), total_price: { amount: 'x', divisor: 100, currency_code: 'USD' } };
  const connector = createEtsyConnector({ ...CREDS, fetchImpl: fakeEtsy([receipt(1), bad]).fetchImpl, now });
  await assert.rejects(() => connector.syncRevenue(store), /malformed money/);
  assert.equal(store.state.ledger.entryOrder.length, 0);
  assert.deepEqual(store.events().map((e) => [e.type, e.payload.ok, e.payload.fetched]), [['connector.sync', false, 2]]);
  store.close();
});

// ---- fees: payment-account ledger -------------------------------------------------------

test('fetchLedgerEntries requires min_created and max_created and pages 100 at a time', async () => {
  const ledger = Array.from({ length: 205 }, (_, i) => line(i + 1, 'transaction', -65));
  const etsy = fakeEtsy([], { ledger });
  const connector = createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl, now });
  await assert.rejects(() => connector.fetchLedgerEntries({ minCreated: 1 }), /minCreated and maxCreated/);
  assert.equal(etsy.requests.length, 0);
  const got = await connector.fetchLedgerEntries({ minCreated: NOW_S - DAY, maxCreated: NOW_S, limit: 1000 });
  assert.equal(got.length, 205);
  const reqs = etsy.ledgerRequests();
  assert.equal(`${reqs[0].url.origin}${reqs[0].url.pathname}`, `${ETSY_API_BASE}/shops/777${LEDGER_PATH}`);
  assert.deepEqual(reqs.map((r) => [r.url.searchParams.get('limit'), r.url.searchParams.get('offset')]), [['100', '0'], ['100', '100'], ['100', '200']]);
  for (const r of reqs) {
    assert.equal(r.url.searchParams.get('min_created'), String(NOW_S - DAY));
    assert.equal(r.url.searchParams.get('max_created'), String(NOW_S));
    assert.equal(r.init.headers['x-api-key'], 'KEYSTRING:SHAREDSECRET');
  }
});

test('ledger lines map conservatively: fee debits are fees, everything else is skipped and counted', () => {
  const fee = ledgerFeeEntry(line(11, 'transaction', -130, { reference_id: '555' }), '777');
  assert.deepEqual(
    { kind: fee.entry.kind, amountCents: fee.entry.amountCents, currency: fee.entry.currency, provenance: fee.entry.provenance, stream: fee.entry.stream, source: fee.entry.source },
    { kind: 'fee', amountCents: 130, currency: 'USD', provenance: 'connector', stream: 'etsy', source: { connector: 'etsy', externalId: 'ledger:11', url: `${ETSY_API_BASE}/shops/777${LEDGER_PATH}` } },
  );
  assert.equal(fee.entry.occurredAt, new Date((NOW_S - 3600) * 1000).toISOString());
  assert.match(fee.entry.memo, /transaction fee .*entry 11.*receipt 555/);
  // ledger_type is matched case- and punctuation-insensitively
  assert.equal(ledgerFeeEntry(line(12, 'PAYMENT_PROCESSING_FEE', -85), '777').entry.amountCents, 85);
  assert.match(ledgerFeeEntry(line(13, 'Offsite Ads Fee', -450), '777').entry.memo, /Offsite Ads fee/);
  for (const type of ['listing', 'renew_sold_auto', 'shipping_transaction', 'transaction_quantity']) {
    assert.equal(ledgerFeeEntry(line(14, type, -20), '777').entry.kind, 'fee', type);
  }
  // not fees: sales credits, refunds, deposits, ads, VAT, unknown types, fee credits (reversals)
  assert.deepEqual(ledgerFeeEntry(line(20, 'Payment', 2300), '777'), { skipped: 'payment' });
  assert.deepEqual(ledgerFeeEntry(line(21, 'REFUND', -700), '777'), { skipped: 'refund' });
  assert.deepEqual(ledgerFeeEntry(line(22, 'prolist', -300), '777'), { skipped: 'prolist' });
  assert.deepEqual(ledgerFeeEntry(line(23, 'vat_seller_services', -26), '777'), { skipped: 'vat_seller_services' });
  assert.deepEqual(ledgerFeeEntry(line(24, 'transaction', 130), '777'), { skipped: 'transaction (credit)' });
  assert.deepEqual(ledgerFeeEntry(line(25, 'listing', 0), '777'), { skipped: 'listing (zero)' });
  assert.deepEqual(ledgerFeeEntry({ entry_id: 26 }, '777'), { skipped: 'untyped' });
  // a fee-typed line must be well formed; a skipped one is never inspected
  assert.throws(() => ledgerFeeEntry(line(27, 'transaction', -1.5), '777'), /malformed amount/);
  assert.throws(() => ledgerFeeEntry({ ...line(28, 'transaction', -5), entry_id: 'x' }, '777'), /malformed entry_id/);
  assert.deepEqual(ledgerFeeEntry({ ...line(29, 'disbursement', 'garbage'), entry_id: null }, '777'), { skipped: 'disbursement' });
  assert.ok(Object.keys(ETSY_FEE_LEDGER_TYPES).every((k) => k === k.toLowerCase()));

  const summary = ledgerFees([line(1, 'transaction', -65), line(2, 'Payment', 1000), line(3, 'Payment', 500), line(4, 'listing', 20)], '777');
  assert.equal(summary.entries.length, 1);
  assert.equal(summary.skipped, 3);
  assert.deepEqual(summary.skippedTypes, { payment: 2, 'listing (credit)': 1 });
});

test('a full sync records fees so the counted net is not overstated', async () => {
  const store = openStore();
  const recent = NOW_S - 2 * DAY;
  const receipts = [receipt(1, { items: 3000, shipping: 500, discount: 0, created: recent })];
  const ledger = [
    line(101, 'Payment', 3500, { at: recent + 10 }), // the sale itself: revenue comes from the receipt
    line(102, 'transaction', -228, { at: recent + 11 }), // 6.5% of 3500
    line(103, 'PAYMENT_PROCESSING_FEE', -130, { at: recent + 12 }),
    line(104, 'listing', -20, { at: recent + 13 }),
    line(105, 'prolist', -150, { at: recent + 14 }), // Etsy Ads: not mapped, reported
  ];
  const etsy = fakeEtsy(receipts, { ledger });
  const connector = createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl, now });

  const result = await connector.syncRevenue(store);
  assert.deepEqual(result, {
    fetched: 1,
    newEntries: 4,
    receipts: { fetched: 1, newEntries: 1 },
    fees: { fetched: 5, feeLines: 3, newEntries: 3, skipped: 2, skippedTypes: { payment: 1, prolist: 1 }, minCreated: NOW_S - 90 * DAY, maxCreated: NOW_S },
  });
  const { totals } = store.state.ledger;
  assert.equal(totals.verifiedRevenueCents, 3500);
  assert.equal(totals.feesCents, 228 + 130 + 20);
  assert.equal(netCents(totals), 3500 - 378);
  const fees = store.state.ledger.entryOrder.map((id) => store.state.ledger.entries[id]).filter((e) => e.kind === 'fee');
  assert.deepEqual(fees.map((e) => e.source.externalId), ['ledger:102', 'ledger:103', 'ledger:104']);
  assert.ok(fees.every((e) => e.provenance === 'connector' && e.source.connector === 'etsy'));

  // first sync: 90 days back; the logged sync carries the window and what was skipped
  const [req] = etsy.ledgerRequests();
  assert.equal(req.url.searchParams.get('min_created'), String(NOW_S - 90 * DAY));
  assert.equal(req.url.searchParams.get('max_created'), String(NOW_S));
  assert.deepEqual(syncs(store)[0].payload.fees, result.fees);
  store.close();
});

test('the fee window resumes from the last successful sync (one day of overlap, deduped)', async () => {
  const store = openStore();
  const ledger = [line(201, 'transaction', -100, { at: NOW_S - 3600 })];
  let clock = NOW_S * 1000;
  const etsy = fakeEtsy([], { ledger });
  const connector = createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl, now: () => clock });

  await connector.syncRevenue(store);
  assert.equal(store.state.ledger.totals.feesCents, 100);

  clock += 3 * DAY * 1000;
  ledger.push(line(202, 'renew_sold_auto', -20, { at: NOW_S + 2 * DAY }));
  const second = await connector.syncRevenue(store);
  const req = etsy.ledgerRequests()[1];
  assert.equal(req.url.searchParams.get('min_created'), String(NOW_S - DAY), 'from the previous max_created minus a day');
  assert.equal(req.url.searchParams.get('max_created'), String(NOW_S + 3 * DAY));
  assert.equal(second.fees.fetched, 2, 'the overlap re-reads line 201');
  assert.equal(second.fees.newEntries, 1, 'and dedups it by entry id');
  assert.equal(store.state.ledger.totals.feesCents, 120);

  // a failed sync does not move the window
  const failing = createEtsyConnector({ ...CREDS, fetchImpl: fakeEtsy([], { ledgerFail: { status: 500, error: 'boom' } }).fetchImpl, now: () => clock });
  await assert.rejects(() => failing.syncRevenue(store), /HTTP 500/);
  clock += DAY * 1000;
  await connector.syncRevenue(store);
  assert.equal(etsy.ledgerRequests()[2].url.searchParams.get('min_created'), String(NOW_S + 3 * DAY - DAY));
  store.close();
});

test('overlapping syncs run one after the other, each starting from what the previous recorded', async () => {
  const store = openStore();
  const etsy = fakeEtsy([receipt(1, { created: NOW_S - DAY })], { ledger: [line(501, 'transaction', -65)] });
  const connector = createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl, now });
  const [a, b] = await Promise.all([connector.syncRevenue(store), connector.syncRevenue(store)]);
  assert.deepEqual([a.newEntries, b.newEntries], [2, 0]);
  assert.deepEqual(etsy.requests.map((r) => (r.url.pathname.endsWith(LEDGER_PATH) ? 'ledger' : 'receipts')), ['receipts', 'ledger', 'receipts', 'ledger']);
  assert.equal(b.fees.minCreated, a.fees.maxCreated - DAY, 'the second window resumes from the first');
  // a failed sync does not wedge the queue
  const failing = createEtsyConnector({ ...CREDS, fetchImpl: fakeEtsy([], { failWith: { status: 503, error: 'down' } }).fetchImpl, now });
  const results = await Promise.allSettled([failing.syncRevenue(store), failing.syncFees(store)]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(store.state.ledger.totals.verifiedRevenueCents, 2300);
  store.close();
});

test('the first fee window reaches back to the oldest receipt it counts', async () => {
  const store = openStore();
  const old = NOW_S - 200 * DAY;
  const etsy = fakeEtsy([receipt(1, { created: old }), receipt(2, { created: NOW_S - DAY })], { ledger: [line(301, 'transaction', -150, { at: old + 60 })] });
  const result = await createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl, now }).syncRevenue(store);
  assert.equal(result.fees.minCreated, old);
  assert.equal(store.state.ledger.totals.feesCents, 150, 'the fee on the 200-day-old order is counted with it');
  store.close();
});

test('if the fee read fails, nothing is recorded: revenue never lands without its fees', async () => {
  const store = openStore();
  const etsy = fakeEtsy([receipt(1)], { ledgerFail: { status: 403, error: 'insufficient scope' } });
  await assert.rejects(() => createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl, now }).syncRevenue(store), /ledger-entries failed with HTTP 403: insufficient scope/);
  assert.equal(store.state.ledger.entryOrder.length, 0);
  assert.deepEqual(syncs(store).map((e) => [e.payload.ok, e.payload.fetched]), [[false, 1]]);

  const bad = fakeEtsy([receipt(1)], { ledger: [{ ...line(1, 'transaction', -10), currency: 42 }] });
  await assert.rejects(() => createEtsyConnector({ ...CREDS, fetchImpl: bad.fetchImpl, now }).syncRevenue(store), /malformed currency/);
  assert.equal(store.state.ledger.entryOrder.length, 0);
  store.close();
});

test('syncFees reads fees on its own and logs a sync the next window resumes from', async () => {
  const store = openStore();
  const etsy = fakeEtsy([], { ledger: [line(401, 'transaction', -65), line(402, 'deposit', -5000)] });
  const connector = createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl, now });
  const result = await connector.syncFees(store);
  assert.deepEqual(result, { fetched: 2, feeLines: 1, newEntries: 1, skipped: 1, skippedTypes: { deposit: 1 }, minCreated: NOW_S - 90 * DAY, maxCreated: NOW_S });
  assert.equal(etsy.receiptRequests().length, 0);
  assert.equal(store.state.ledger.totals.feesCents, 65);
  const [sync] = syncs(store);
  assert.deepEqual(sync.payload, { connector: 'etsy', ok: true, fetched: 2, newEntries: 1, fees: result });
  await connector.syncFees(store);
  assert.equal(etsy.ledgerRequests()[1].url.searchParams.get('min_created'), String(NOW_S - DAY));
  store.close();
});

// ---- listings ---------------------------------------------------------------------------

test('createDraftListing posts the required form fields and needs a taxonomy id', async () => {
  const draft = { title: 'Grow Gently Sweatshirt', description: 'Desc', price: 34, quantity: 25, who_made: 'i_did', when_made: 'made_to_order', is_supply: false, tags: ['garden sweatshirt', "gardener's gift"] };
  await assert.rejects(() => createEtsyConnector(CREDS).createDraftListing(draft), /ETSY_TAXONOMY_ID/);

  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ listing_id: 4242, state: 'draft', url: 'https://www.etsy.com/listing/4242/grow-gently' }), { status: 201 });
  };
  const result = await createEtsyConnector({ ...CREDS, taxonomyId: 2078, fetchImpl }).createDraftListing(draft);
  assert.deepEqual(result, { listingId: 4242, url: 'https://www.etsy.com/listing/4242/grow-gently' });
  assert.equal(requests[0].url, `${ETSY_API_BASE}/shops/777/listings`);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = Object.fromEntries(new URLSearchParams(requests[0].init.body.toString()));
  assert.deepEqual(form, {
    quantity: '25', title: 'Grow Gently Sweatshirt', description: 'Desc', price: '34', who_made: 'i_did',
    when_made: 'made_to_order', taxonomy_id: '2078', is_supply: 'false', tags: "garden sweatshirt,gardener's gift",
  });
});

test('createDraftListing sends who_made, production partners and the shipping profile when configured', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ listing_id: 7 }), { status: 201 });
  };
  const draft = { title: 'T', description: 'D', price: 30, quantity: 5, who_made: 'someone_else', production_partner_ids: [31, 32], when_made: 'made_to_order', is_supply: false, tags: ['t'] };
  await createEtsyConnector({ ...CREDS, taxonomyId: 2078, shippingProfileId: 998877, fetchImpl }).createDraftListing(draft);
  const form = Object.fromEntries(new URLSearchParams(requests[0].init.body.toString()));
  assert.equal(form.who_made, 'someone_else');
  assert.equal(form.production_partner_ids, '31,32');
  assert.equal(form.shipping_profile_id, '998877');
  assert.equal(form.taxonomy_id, '2078');

  await createEtsyConnector({ ...CREDS, taxonomyId: 2078, fetchImpl }).createDraftListing({ ...draft, production_partner_ids: null });
  const bare = Object.fromEntries(new URLSearchParams(requests[1].init.body.toString()));
  assert.equal(Object.hasOwn(bare, 'shipping_profile_id'), false, 'no shipping profile configured: none is sent');
  assert.equal(Object.hasOwn(bare, 'production_partner_ids'), false);
});

test("Etsy's rejection text is surfaced verbatim, with the setting that would fix it", async () => {
  const etsyText = 'shipping_profile_id is required when listing type is physical';
  const fetchImpl = async () => json(400, { error: etsyText });
  const draft = { title: 'T', description: 'D', price: 30, quantity: 5, who_made: 'i_did', when_made: 'made_to_order', is_supply: false, tags: [] };
  await assert.rejects(
    () => createEtsyConnector({ ...CREDS, taxonomyId: 2078, fetchImpl }).createDraftListing(draft),
    (err) => err.message.includes(`HTTP 400: ${etsyText}`) && /ETSY_SHIPPING_PROFILE_ID is not set/.test(err.message),
  );
  const rejected = 'Invalid shipping_profile_id 998877 for shop 777';
  await assert.rejects(
    () => createEtsyConnector({ ...CREDS, taxonomyId: 2078, shippingProfileId: 998877, fetchImpl: async () => json(400, { error: rejected }) }).createDraftListing(draft),
    (err) => err.message.endsWith(`HTTP 400: ${rejected}`),
  );
});

test('uploadListingImage sends PNG/JPEG as multipart and refuses SVG', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ listing_image_id: 31 }), { status: 201 });
  };
  const connector = createEtsyConnector({ ...CREDS, fetchImpl });
  await assert.rejects(() => connector.uploadListingImage(4242, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'd.svg'), /SVG is not accepted/);
  assert.deepEqual(await connector.uploadListingImage(4242, PNG, 'image.png'), { imageId: 31 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${ETSY_API_BASE}/shops/777/listings/4242/images`);
  assert.ok(requests[0].init.body instanceof FormData);
  const file = requests[0].init.body.get('image');
  assert.equal(file.type, 'image/png');
  assert.equal(file.name, 'image.png');
  assert.equal(requests[0].init.headers['content-type'], undefined, 'fetch sets the multipart boundary itself');
});

test('an unconfigured connector never calls the network', async () => {
  let called = false;
  const connector = createEtsyConnector({ ...CREDS, accessToken: null, fetchImpl: async () => { called = true; } });
  await assert.rejects(() => connector.fetchReceipts(), /not configured/);
  assert.equal(called, false);
});
