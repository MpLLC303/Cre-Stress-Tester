import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../sidecar/store.js';
import { createEtsyConnector, receiptEntries, ETSY_API_BASE } from '../sidecar/connectors/etsy.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-'));
const CREDS = { apiKey: 'KEYSTRING', sharedSecret: 'SHAREDSECRET', accessToken: '123.TOKEN', shopId: '777' };
const usd = (cents) => ({ amount: cents, divisor: 100, currency_code: 'USD' });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png')]);

function receipt(id, { items = 2000, shipping = 500, discount = 200, tax = 160, vat = 0, paid = true, refunds = [], created = 1_780_000_000 } = {}) {
  return {
    receipt_id: id,
    is_paid: paid,
    status: paid ? 'paid' : 'open',
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

/** A fake Etsy that serves `receipts` with offset/limit paging and records every request. */
function fakeEtsy(receipts, { failWith } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    requests.push({ url: u, init });
    if (failWith) return new Response(JSON.stringify({ error: failWith.error }), { status: failWith.status });
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset'));
    return new Response(JSON.stringify({ count: receipts.length, results: receipts.slice(offset, offset + limit) }), { status: 200 });
  };
  return { requests, fetchImpl };
}

function openStore() {
  return createStore({ dataDir: tmp() });
}

test('configured needs keystring, shared secret, token and shop id', () => {
  assert.equal(createEtsyConnector(CREDS).configured, true);
  for (const key of Object.keys(CREDS)) assert.equal(createEtsyConnector({ ...CREDS, [key]: null }).configured, false, key);
  assert.equal(createEtsyConnector().configured, false);
});

test('requests carry keystring:shared_secret in x-api-key and the bearer token', async () => {
  const etsy = fakeEtsy([receipt(1)]);
  await createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl }).fetchReceipts({ minCreated: 1_700_000_000 });
  const [{ url, init }] = etsy.requests;
  assert.equal(`${url.origin}${url.pathname}`, `${ETSY_API_BASE}/shops/777/receipts`);
  assert.equal(init.method, 'GET');
  assert.equal(init.headers['x-api-key'], 'KEYSTRING:SHAREDSECRET');
  assert.equal(init.headers.authorization, 'Bearer 123.TOKEN');
  assert.equal(url.searchParams.get('min_created'), '1700000000');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('offset'), '0');
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

test('syncRevenue records verified entries once and reports only new ones', async () => {
  const store = openStore();
  const receipts = Array.from({ length: 150 }, (_, i) => receipt(i + 1, { items: 1000, shipping: 0, discount: 0 }));
  receipts.push(receipt(999, { paid: false }));
  const etsy = fakeEtsy(receipts);
  const connector = createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl });

  assert.deepEqual(await connector.syncRevenue(store), { fetched: 151, newEntries: 150 });
  assert.equal(etsy.requests.length, 2);
  assert.equal(store.state.ledger.totals.verifiedRevenueCents, 150_000);
  assert.equal(store.state.ledger.totals.verifiedOrders, 150);
  const syncs = () => store.events().filter((e) => e.type === 'connector.sync');
  assert.deepEqual(syncs()[0].payload, { connector: 'etsy', ok: true, fetched: 151, newEntries: 150 });
  assert.equal(syncs()[0].actor, 'connector:etsy');

  receipts.push(receipt(151, { items: 4000, shipping: 0, discount: 0 }));
  const before = store.state.ledger.entryOrder.length;
  assert.deepEqual(await connector.syncRevenue(store), { fetched: 152, newEntries: 1 });
  assert.equal(store.state.ledger.entryOrder.length, before + 1);
  assert.equal(store.state.ledger.totals.verifiedRevenueCents, 154_000);
  assert.deepEqual(syncs()[1].payload, { connector: 'etsy', ok: true, fetched: 152, newEntries: 1 });
  store.close();
});

test('an HTTP error emits connector.sync ok:false without leaking credentials', async () => {
  const store = openStore();
  const etsy = fakeEtsy([], { failWith: { status: 403, error: 'Invalid API key: KEYSTRING:SHAREDSECRET' } });
  const connector = createEtsyConnector({ ...CREDS, fetchImpl: etsy.fetchImpl });
  await assert.rejects(() => connector.syncRevenue(store), (err) => /HTTP 403/.test(err.message) && !/KEYSTRING|SHAREDSECRET/.test(err.message));
  const [sync] = store.events().filter((e) => e.type === 'connector.sync');
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
  const connector = createEtsyConnector({ ...CREDS, fetchImpl: fakeEtsy([receipt(1), bad]).fetchImpl });
  await assert.rejects(() => connector.syncRevenue(store), /malformed money/);
  assert.equal(store.state.ledger.entryOrder.length, 0);
  assert.deepEqual(store.events().map((e) => [e.type, e.payload.ok, e.payload.fetched]), [['connector.sync', false, 2]]);
  store.close();
});

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
