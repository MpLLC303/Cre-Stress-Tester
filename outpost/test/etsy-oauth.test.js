// Etsy OAuth refresh: 1-hour access tokens are renewed with ETSY_REFRESH_TOKEN, the rotated pair is
// persisted 0600 and preferred on boot, and no token ever reaches an error, event or log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../sidecar/store.js';
import { createEtsyConnector, ETSY_API_BASE, ETSY_TOKEN_URL, TOKEN_FILE_SCHEMA } from '../sidecar/connectors/etsy.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-oauth-'));
const BASE = { apiKey: 'KEYSTRING', sharedSecret: 'SHAREDSECRET', shopId: '777' };
const json = (status, body) => new Response(JSON.stringify(body), { status });
const NOW = 1_790_000_000_000;
const SECRET_RE = /KEYSTRING|SHAREDSECRET|ACCESS-|REFRESH-/;

/**
 * A fake Etsy with a token endpoint that rotates the refresh token on every use. `valid` is the
 * set of access tokens the API accepts; the API answers 401 to anything else.
 */
function fakeOAuth({ valid = new Set(), tokenStatus = 200, tokenBody, expiresIn = 3600 } = {}) {
  const api = [];
  const token = [];
  let issued = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url === ETSY_TOKEN_URL) {
      const form = new URLSearchParams(init.body.toString());
      token.push({ init, form: Object.fromEntries(form) });
      if (tokenStatus !== 200) return json(tokenStatus, tokenBody ?? { error: 'invalid_grant', error_description: `refresh token ${form.get('refresh_token')} is invalid` });
      issued += 1;
      const access = `ACCESS-${issued}`;
      valid.add(access);
      return json(200, tokenBody ?? { access_token: access, token_type: 'Bearer', expires_in: expiresIn, refresh_token: `REFRESH-${issued}` });
    }
    const u = new URL(url);
    const bearer = (init.headers.authorization || '').replace(/^Bearer /, '');
    api.push({ url: u, bearer });
    if (!valid.has(bearer)) return json(401, { error: 'invalid_token', error_description: `token ${bearer} expired` });
    return json(200, { count: 0, results: [] });
  };
  return { fetchImpl, api, token, valid };
}

const tokenFileIn = (dir) => path.join(dir, 'secrets', 'etsy-token.json');
const readTokenFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('a 401 refreshes once (rotating the refresh token), retries once, and persists the pair 0600', async () => {
  const dir = tmp();
  const file = tokenFileIn(dir);
  const etsy = fakeOAuth();
  const logs = [];
  const connector = createEtsyConnector({ ...BASE, accessToken: 'ACCESS-stale', refreshToken: 'REFRESH-0', tokenFile: file, fetchImpl: etsy.fetchImpl, now: () => NOW, log: (m) => logs.push(m) });

  assert.deepEqual(await connector.fetchReceipts(), []);
  assert.deepEqual(etsy.api.map((r) => r.bearer), ['ACCESS-stale', 'ACCESS-1'], 'one retry with the new token');
  assert.equal(etsy.token.length, 1);
  const [{ init, form }] = etsy.token;
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(form, { grant_type: 'refresh_token', client_id: 'KEYSTRING', refresh_token: 'REFRESH-0' });
  assert.equal(ETSY_TOKEN_URL, 'https://api.etsy.com/v3/public/oauth/token');

  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600, 'owner read/write only');
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0, 'secrets dir is owner-only');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['etsy-token.json'], 'atomic write leaves no temp file');
  const saved = readTokenFile(file);
  assert.equal(saved.schema, TOKEN_FILE_SCHEMA);
  assert.equal(saved.access_token, 'ACCESS-1');
  assert.equal(saved.refresh_token, 'REFRESH-1', 'the rotated refresh token is what is kept');
  assert.equal(saved.expires_at, new Date(NOW + 3600 * 1000).toISOString());
  assert.deepEqual(logs, []);

  // The next refresh spends the rotated token, not the original.
  etsy.valid.clear();
  await connector.fetchReceipts();
  assert.equal(etsy.token[1].form.refresh_token, 'REFRESH-1');
  assert.equal(readTokenFile(file).refresh_token, 'REFRESH-2');
});

test('on boot the saved pair wins over the environment, and a known expiry refreshes before the call', async () => {
  const dir = tmp();
  const file = tokenFileIn(dir);
  const first = fakeOAuth();
  await createEtsyConnector({ ...BASE, accessToken: 'ACCESS-stale', refreshToken: 'REFRESH-0', tokenFile: file, fetchImpl: first.fetchImpl, now: () => NOW }).fetchReceipts();

  // restart with the same (now spent) env tokens: the file is used
  const etsy = fakeOAuth({ valid: new Set(['ACCESS-1']) });
  let clock = NOW;
  const booted = createEtsyConnector({ ...BASE, accessToken: 'ACCESS-stale', refreshToken: 'REFRESH-0', tokenFile: file, fetchImpl: etsy.fetchImpl, now: () => clock });
  assert.deepEqual(booted.tokenStatus(), { source: 'file', refreshable: true, expiresAt: new Date(NOW + 3600 * 1000).toISOString(), persisted: true });
  await booted.fetchReceipts();
  assert.deepEqual(etsy.api.map((r) => r.bearer), ['ACCESS-1']);
  assert.equal(etsy.token.length, 0);

  // 59 minutes on the token is within a minute of expiry: refresh first, no 401 round trip
  clock = NOW + 3550 * 1000;
  await booted.fetchReceipts();
  assert.equal(etsy.token.length, 1);
  assert.equal(etsy.token[0].form.refresh_token, 'REFRESH-1');
  assert.deepEqual(etsy.api.map((r) => r.bearer), ['ACCESS-1', 'ACCESS-1'], 'the fake re-issues ACCESS-1 (its counter restarted)');
  assert.equal(readTokenFile(file).refresh_token, 'REFRESH-1');
});

test('a new ETSY_REFRESH_TOKEN (re-authorization) overrides an older saved pair', async () => {
  const dir = tmp();
  const file = tokenFileIn(dir);
  await createEtsyConnector({ ...BASE, accessToken: 'ACCESS-stale', refreshToken: 'REFRESH-0', tokenFile: file, fetchImpl: fakeOAuth().fetchImpl, now: () => NOW }).fetchReceipts();
  const logs = [];
  const reauthorized = createEtsyConnector({ ...BASE, accessToken: 'ACCESS-new', refreshToken: 'REFRESH-new', tokenFile: file, fetchImpl: fakeOAuth().fetchImpl, now: () => NOW, log: (m) => logs.push(m) });
  assert.equal(reauthorized.tokenStatus().source, 'env');
  assert.match(logs.join('\n'), /ETSY_REFRESH_TOKEN changed/);
  assert.doesNotMatch(logs.join('\n'), SECRET_RE);
});

test('a refresh token alone is enough: the first call mints an access token', async () => {
  const etsy = fakeOAuth();
  const connector = createEtsyConnector({ ...BASE, accessToken: null, refreshToken: 'REFRESH-0', fetchImpl: etsy.fetchImpl, now: () => NOW });
  assert.equal(connector.configured, true);
  await connector.fetchReceipts();
  assert.equal(etsy.token.length, 1);
  assert.deepEqual(etsy.api.map((r) => r.bearer), ['ACCESS-1']);
  assert.equal(connector.tokenStatus().persisted, false, 'no token file: kept in memory only');
});

test('only one retry: a second 401 after refreshing is an error, and nothing loops', async () => {
  const etsy = fakeOAuth();
  const always401 = async (url, init) => (url === ETSY_TOKEN_URL ? etsy.fetchImpl(url, init) : json(401, { error: 'invalid_token' }));
  const connector = createEtsyConnector({ ...BASE, accessToken: 'ACCESS-stale', refreshToken: 'REFRESH-0', fetchImpl: always401, now: () => NOW });
  await assert.rejects(() => connector.fetchReceipts(), /HTTP 401/);
  assert.equal(etsy.token.length, 1);
});

test('without a refresh token a 401 is reported as is and the token endpoint is never called', async () => {
  const etsy = fakeOAuth();
  const connector = createEtsyConnector({ ...BASE, accessToken: 'ACCESS-stale', fetchImpl: etsy.fetchImpl, now: () => NOW });
  await assert.rejects(() => connector.fetchReceipts(), (err) => /HTTP 401/.test(err.message) && !SECRET_RE.test(err.message));
  assert.equal(etsy.token.length, 0);
  assert.equal(connector.tokenStatus().refreshable, false);
});

test('concurrent 401s share one refresh (a second would spend a rotated token)', async () => {
  const etsy = fakeOAuth();
  const connector = createEtsyConnector({ ...BASE, accessToken: 'ACCESS-stale', refreshToken: 'REFRESH-0', fetchImpl: etsy.fetchImpl, now: () => NOW });
  await Promise.all([connector.fetchReceipts(), connector.fetchReceipts(), connector.fetchLedgerEntries({ minCreated: 1_700_000_000, maxCreated: 1_700_000_100 })]);
  assert.equal(etsy.token.length, 1);
  assert.equal(etsy.api.filter((r) => r.bearer === 'ACCESS-1').length, 3);
});

test('a failed refresh is redacted everywhere: error, connector.sync event, log', async () => {
  const dir = tmp();
  const store = createStore({ dataDir: dir });
  const logs = [];
  // Etsy echoes the refresh token back in its error; it must not survive.
  const etsy = fakeOAuth({ tokenStatus: 400 });
  const connector = createEtsyConnector({ ...BASE, accessToken: 'ACCESS-stale', refreshToken: 'REFRESH-0', tokenFile: tokenFileIn(dir), fetchImpl: etsy.fetchImpl, now: () => NOW, log: (m) => logs.push(m) });
  await assert.rejects(() => connector.syncRevenue(store), (err) => {
    assert.match(err.message, /Etsy token refresh failed with HTTP 400: refresh token \[redacted\] is invalid/);
    assert.match(err.message, /set the new ETSY_REFRESH_TOKEN/);
    assert.doesNotMatch(err.message, SECRET_RE);
    return true;
  });
  const [sync] = store.events().filter((e) => e.type === 'connector.sync');
  assert.equal(sync.payload.ok, false);
  assert.doesNotMatch(JSON.stringify(store.events()), SECRET_RE);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8'), SECRET_RE);
  assert.doesNotMatch(logs.join('\n'), SECRET_RE);
  assert.equal(fs.existsSync(tokenFileIn(dir)), false, 'nothing is persisted from a failed refresh');
  store.close();
});

test('rotated tokens are redacted too, and tokenStatus never carries token material', async () => {
  const valid = new Set();
  const etsy = fakeOAuth({ valid });
  let fail = false;
  const fetchImpl = async (url, init) => {
    if (fail && url !== ETSY_TOKEN_URL) return json(500, { error: `server echoed ${init.headers.authorization}` });
    return etsy.fetchImpl(url, init);
  };
  const connector = createEtsyConnector({ ...BASE, accessToken: 'ACCESS-stale', refreshToken: 'REFRESH-0', fetchImpl, now: () => NOW });
  await connector.fetchReceipts();
  fail = true;
  await assert.rejects(() => connector.fetchReceipts(), (err) => /HTTP 500: server echoed Bearer \[redacted\]/.test(err.message) && !SECRET_RE.test(err.message));
  assert.doesNotMatch(JSON.stringify(connector.tokenStatus()), SECRET_RE);
  assert.doesNotMatch(connector.redact('REFRESH-1 ACCESS-1 KEYSTRING:SHAREDSECRET'), SECRET_RE);
});

test('redaction is idempotent and never shreds a message', () => {
  // "dact" occurs inside the marker itself: redacting twice (connector, then server) must not
  // eat into "[redacted]"; values under 4 characters are not credentials and are left alone.
  const connector = createEtsyConnector({ apiKey: 'dact', sharedSecret: 's', accessToken: 'ACCESS-zz', shopId: '1' });
  const once = connector.redact('key dact, token ACCESS-zz, status 401');
  assert.equal(once, 'key [redacted], token [redacted], status 401');
  assert.equal(connector.redact(once), once);
});

test('a corrupt or foreign token file falls back to the environment without logging its contents', async () => {
  const dir = tmp();
  const file = tokenFileIn(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'ACCESS-leaked-in-garbage {', { mode: 0o644 });
  const logs = [];
  const etsy = fakeOAuth({ valid: new Set(['ACCESS-env']) });
  const connector = createEtsyConnector({ ...BASE, accessToken: 'ACCESS-env', tokenFile: file, fetchImpl: etsy.fetchImpl, now: () => NOW, log: (m) => logs.push(m) });
  assert.equal(connector.tokenStatus().source, 'env');
  await connector.fetchReceipts();
  assert.deepEqual(etsy.api.map((r) => r.bearer), ['ACCESS-env']);
  assert.match(logs.join('\n'), /cannot read .*etsy-token\.json \(unparseable\)/);
  assert.doesNotMatch(logs.join('\n'), /leaked|garbage/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'a loose token file is tightened to 0600');

  fs.writeFileSync(file, JSON.stringify({ access_token: 'ACCESS-x', refresh_token: 'REFRESH-x' }));
  createEtsyConnector({ ...BASE, accessToken: 'ACCESS-env', tokenFile: file, fetchImpl: etsy.fetchImpl, log: (m) => logs.push(m) });
  assert.match(logs.at(-1), /not an Outpost Etsy token file/);
});

test('if the rotated pair cannot be saved, the connector keeps working from memory and says so', async () => {
  const dir = tmp();
  const blocker = path.join(dir, 'secrets');
  fs.writeFileSync(blocker, 'a file where the secrets directory should be');
  const logs = [];
  const etsy = fakeOAuth();
  const connector = createEtsyConnector({ ...BASE, accessToken: 'ACCESS-stale', refreshToken: 'REFRESH-0', tokenFile: path.join(blocker, 'etsy-token.json'), fetchImpl: etsy.fetchImpl, now: () => NOW, log: (m) => logs.push(m) });
  await connector.fetchReceipts();
  assert.deepEqual(etsy.api.map((r) => r.bearer), ['ACCESS-stale', 'ACCESS-1']);
  assert.match(logs.join('\n'), /could not save the rotated Etsy token .*held in memory only/);
  assert.doesNotMatch(logs.join('\n'), SECRET_RE);
  etsy.valid.clear();
  await connector.fetchReceipts();
  assert.equal(etsy.token[1].form.refresh_token, 'REFRESH-1', 'the in-memory rotated token is still used');
});

test('listing creation retries after a refresh with the same form body', async () => {
  const etsy = fakeOAuth();
  const posts = [];
  const fetchImpl = async (url, init) => {
    if (url === `${ETSY_API_BASE}/shops/777/listings`) {
      posts.push({ bearer: init.headers.authorization, body: init.body.toString() });
      if (init.headers.authorization !== 'Bearer ACCESS-1') return json(401, { error: 'invalid_token' });
      return json(201, { listing_id: 5 });
    }
    return etsy.fetchImpl(url, init);
  };
  const connector = createEtsyConnector({ ...BASE, accessToken: 'ACCESS-stale', refreshToken: 'REFRESH-0', taxonomyId: 1, fetchImpl, now: () => NOW });
  const res = await connector.createDraftListing({ title: 'T', description: 'D', price: 20, quantity: 1, who_made: 'i_did', when_made: 'made_to_order', is_supply: false, tags: ['t'] });
  assert.equal(res.listingId, 5);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body, posts[1].body);
});
