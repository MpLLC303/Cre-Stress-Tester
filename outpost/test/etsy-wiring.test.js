// Etsy settings flow from the environment (config.js) through the boot path (index.js) into the
// connector, and the sync route (server.js) answers with counts only, never secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../sidecar/config.js';
import { createEtsyConnector, ETSY_TOKEN_URL, TOKEN_FILE_SCHEMA } from '../sidecar/connectors/etsy.js';
import { etsyTokenFile, startStation } from '../sidecar/index.js';
import { createServer } from '../sidecar/server.js';
import { createStore } from '../sidecar/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-wiring-'));
const json = (status, body) => new Response(JSON.stringify(body), { status });
const SECRET_RE = /KEY-SECRET|SHARED-SECRET|ACCESS-|REFRESH-/;
const ENV = {
  OUTPOST_PROVIDER: 'scripted', PORT: '0', HOST: '127.0.0.1', OUTPOST_TICK_MS: '50',
  ETSY_API_KEY: 'KEY-SECRET', ETSY_SHARED_SECRET: 'SHARED-SECRET', ETSY_ACCESS_TOKEN: 'ACCESS-env', ETSY_REFRESH_TOKEN: 'REFRESH-env',
  ETSY_SHOP_ID: '777', ETSY_TAXONOMY_ID: '2078', ETSY_SHIPPING_PROFILE_ID: '998877',
};

test('config reads the Etsy taxonomy id (a number), shipping profile id and refresh token', () => {
  const { etsy } = loadConfig({ ...ENV, OUTPOST_DATA: tmp() });
  assert.deepEqual(etsy, {
    apiKey: 'KEY-SECRET', sharedSecret: 'SHARED-SECRET', accessToken: 'ACCESS-env', refreshToken: 'REFRESH-env',
    shopId: '777', taxonomyId: 2078, shippingProfileId: 998877,
  });
  const bare = loadConfig({ OUTPOST_PROVIDER: 'scripted' }).etsy;
  assert.equal(bare.taxonomyId, null);
  assert.equal(bare.shippingProfileId, null);
  assert.equal(bare.refreshToken, null);
  assert.equal(loadConfig({ ETSY_TAXONOMY_ID: ' ', ETSY_SHIPPING_PROFILE_ID: '' }).etsy.taxonomyId, null, 'blank means unset');
  assert.throws(() => loadConfig({ ETSY_TAXONOMY_ID: 'mugs' }), /ETSY_TAXONOMY_ID must be a positive whole number/);
  assert.throws(() => loadConfig({ ETSY_TAXONOMY_ID: '0' }), /ETSY_TAXONOMY_ID/);
  assert.throws(() => loadConfig({ ETSY_SHIPPING_PROFILE_ID: '12.5' }), /ETSY_SHIPPING_PROFILE_ID must be a positive whole number/);
});

test('boot wires the Etsy settings and the saved token file into the connector, and exposes no secret', async (t) => {
  const dataDir = tmp();
  const config = loadConfig({ ...ENV, OUTPOST_DATA: dataDir });
  const file = etsyTokenFile(dataDir);
  assert.equal(file, path.join(dataDir, 'secrets', 'etsy-token.json'));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({
    schema: TOKEN_FILE_SCHEMA, access_token: 'ACCESS-saved', refresh_token: 'REFRESH-saved',
    expires_at: new Date(Date.now() + 3_000_000).toISOString(), seed_sha256: createHash('sha256').update('REFRESH-env').digest('hex'),
  }), { mode: 0o600 });

  // The connector captures `fetch` when it is created: stub it so nothing reaches Etsy.
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return json(201, { listing_id: 1 });
  };
  let station;
  try {
    station = await startStation(config);
  } finally {
    globalThis.fetch = realFetch;
  }
  t.after(() => station.stop());

  const etsy = station.connectors.etsy;
  assert.equal(etsy.configured, true);
  assert.equal(etsy.tokenStatus().source, 'file', 'the saved (rotated) pair wins over the env');
  await etsy.createDraftListing({ title: 'T', description: 'D', price: 20, quantity: 1, who_made: 'i_did', when_made: 'made_to_order', is_supply: false, tags: [] });
  const form = Object.fromEntries(new URLSearchParams(requests[0].init.body.toString()));
  assert.equal(form.taxonomy_id, '2078');
  assert.equal(form.shipping_profile_id, '998877');
  assert.equal(requests[0].init.headers.authorization, 'Bearer ACCESS-saved');
  assert.equal(requests[0].init.headers['x-api-key'], 'KEY-SECRET:SHARED-SECRET');

  const snapshot = await realFetch(`${station.url}api/snapshot`);
  const text = await snapshot.text();
  assert.deepEqual(JSON.parse(text).meta.connectors, { etsy: { configured: true, setup: null } });
  assert.doesNotMatch(text, SECRET_RE);
  assert.doesNotMatch(fs.readFileSync(path.join(dataDir, 'events.ndjson'), 'utf8'), SECRET_RE);
});

// ---- POST /api/connectors/etsy/sync ---------------------------------------------------------

async function serve(t, connectors) {
  const dataDir = tmp();
  const store = createStore({ dataDir });
  const server = createServer({ store, dispatcher: {}, scheduler: {}, config: { dataDir, allowHosts: [] }, meta: {}, connectors });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    server.closeAllConnections();
    store.close();
  });
  const post = (p) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: p, headers: { 'x-outpost-client': '1', 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end('{}');
  });
  return { store, post };
}

test('the sync route explains ETSY_REFRESH_TOKEN when unconfigured and answers with counts only', async (t) => {
  const off = await serve(t, { etsy: createEtsyConnector({}) });
  const notConfigured = await off.post('/api/connectors/etsy/sync');
  assert.equal(notConfigured.status, 501);
  assert.match(JSON.parse(notConfigured.text).error, /ETSY_SHARED_SECRET.*ETSY_ACCESS_TOKEN \(or ETSY_REFRESH_TOKEN instead/);

  // a 401 mid-sync: refresh, retry, record receipt + fee; the response carries no token
  const fetchImpl = async (url, init) => {
    if (url === ETSY_TOKEN_URL) return json(200, { access_token: 'ACCESS-new', expires_in: 3600, refresh_token: 'REFRESH-new' });
    if (init.headers.authorization !== 'Bearer ACCESS-new') return json(401, { error: 'invalid_token' });
    if (url.includes('/payment-account/ledger-entries')) {
      return json(200, { count: 1, results: [{ entry_id: 5, amount: -65, currency: 'USD', ledger_type: 'transaction', created_timestamp: Math.floor(Date.now() / 1000) - 60 }] });
    }
    const usd = (cents) => ({ amount: cents, divisor: 100, currency_code: 'USD' });
    return json(200, { count: 1, results: [{ receipt_id: 9, is_paid: true, status: 'paid', create_timestamp: Math.floor(Date.now() / 1000) - 120, total_price: usd(1000), total_shipping_cost: usd(0), discount_amt: usd(0), refunds: [] }] });
  };
  const etsy = createEtsyConnector({ apiKey: 'KEY-SECRET', sharedSecret: 'SHARED-SECRET', accessToken: 'ACCESS-old', refreshToken: 'REFRESH-old', shopId: '1', fetchImpl });
  const on = await serve(t, { etsy });
  const synced = await on.post('/api/connectors/etsy/sync');
  assert.equal(synced.status, 200);
  // receipts and fee lines are counted separately (fetched/newEntries alone read as "2 new of 1")
  assert.deepEqual(JSON.parse(synced.text), { fetched: 1, newEntries: 2, receipts: { fetched: 1, newEntries: 1 }, fees: { fetched: 1, newEntries: 1 } });
  assert.equal(on.store.state.ledger.totals.verifiedRevenueCents, 1000);
  assert.equal(on.store.state.ledger.totals.feesCents, 65);
  assert.doesNotMatch(synced.text, SECRET_RE);
  assert.doesNotMatch(JSON.stringify(on.store.events()), SECRET_RE);
});

test('a failed refresh during sync is a redacted 502', async (t) => {
  const fetchImpl = async (url, init) => {
    if (url === ETSY_TOKEN_URL) return json(400, { error: `invalid_grant for ${new URLSearchParams(init.body.toString()).get('refresh_token')}` });
    return json(401, { error: `expired ${init.headers.authorization}` });
  };
  const etsy = createEtsyConnector({ apiKey: 'KEY-SECRET', sharedSecret: 'SHARED-SECRET', accessToken: 'ACCESS-old', refreshToken: 'REFRESH-old', shopId: '1', fetchImpl });
  const { post, store } = await serve(t, { etsy });
  const res = await post('/api/connectors/etsy/sync');
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.text).error, /token refresh failed with HTTP 400: invalid_grant for \[redacted\]/);
  assert.doesNotMatch(res.text, SECRET_RE);
  assert.doesNotMatch(JSON.stringify(store.events()), SECRET_RE);
});
