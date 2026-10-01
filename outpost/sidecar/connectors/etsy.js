// Etsy Open API v3 connector: the only source of `connector`-provenance money for the Etsy stream.
//
// Verified against Etsy's API (2026; OpenAPI spec mirror + github.com/etsy/open-api discussions):
// - every request sends `x-api-key: <keystring>:<shared_secret>` (the shared secret is enforced
//   since 2026-02-09, github.com/etsy/open-api/discussions/1529) plus `Authorization: Bearer <token>`;
// - access tokens last about an hour. With a refresh token, a 401 (or a known expiry) triggers
//   POST https://api.etsy.com/v3/public/oauth/token (grant_type=refresh_token, client_id=<keystring>,
//   refresh_token) and ONE retry. Etsy rotates the refresh token, so the new pair is written
//   atomically, mode 0600, to <dataDir>/secrets/etsy-token.json and preferred over the env on boot;
// - getShopReceipts: GET /shops/{shop_id}/receipts, limit 1..100 + offset, response {count, results};
// - Money is {amount, divisor, currency_code}; `subtotal` is already net of coupon discounts, so
//   revenue is computed from `total_price` (items) + `total_shipping_cost` - `discount_amt`,
//   which excludes `total_tax_cost`/`total_vat_cost` (tax collected for remittance);
// - receipts carry `refunds` (amount, created_timestamp, reason, status; no refund id), and
//   `status` includes "fully refunded" and "partially refunded" (plus "canceled"), so is_paid alone
//   overstates revenue: refunds are recorded against the receipt and never exceed what it counted;
// - getShopPaymentAccountLedgerEntries: GET /shops/{shop_id}/payment-account/ledger-entries, scope
//   transactions_r, min_created AND max_created required, limit 1..100 + offset. `amount` is an
//   integer in the currency's minor unit, "credited to the ledger" (debits are negative);
//   `ledger_type` is a free string (the spec enumerates no values);
// - createDraftListing: POST /shops/{shop_id}/listings, form-encoded, array fields comma-joined.
//   shipping_profile_id is sent when configured: the spec still says "required when physical",
//   discussion #1524 says drafts may omit it, so Etsy's own error text is surfaced verbatim;
// - uploadListingImage: POST /shops/{shop_id}/listings/{listing_id}/images, multipart `image`
//   (JPG/PNG/GIF; SVG is not accepted).
// Fees are never estimated: they are recorded only from payment-account ledger lines whose
// ledger_type names an Etsy selling fee (ETSY_FEE_LEDGER_TYPES). Secrets (keystring, shared
// secret, access and refresh tokens) are redacted from every error and never put in events.

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { newId } from '../ids.js';
import { sniffImageMime } from '../images.js';

export const ETSY_API_BASE = 'https://openapi.etsy.com/v3/application';
/**
 * What `configured` needs (see createEtsyConnector), in one place: the server's 501, the
 * sync_connector tool and the UI (via meta.connectors.etsy.setup) all quote it.
 */
export const ETSY_SETUP_HINT =
  'set ETSY_API_KEY, ETSY_SHARED_SECRET, ETSY_SHOP_ID and ETSY_ACCESS_TOKEN (or ETSY_REFRESH_TOKEN instead, so the 1-hour access token can be renewed), then restart the sidecar';
/** Per-request deadlines: a hung Etsy call fails instead of holding a run (and its agent) forever. */
export const ETSY_REQUEST_TIMEOUT_MS = 30_000;
export const ETSY_UPLOAD_TIMEOUT_MS = 120_000;
export const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
export const TOKEN_FILE_SCHEMA = 'outpost.etsy-token/1';
const PAGE_MAX = 100;
const ACTOR = 'connector:etsy';
const REFRESH_EARLY_MS = 60_000; // refresh a token this close to its known expiry
const ETSY_MIN_TIMESTAMP = 946_684_800; // spec minimum for min_created / max_created
const DAY_S = 86_400;
const FEE_WINDOW_OVERLAP_S = DAY_S; // re-read the last day: late-posted lines are deduped by entry id
const MAX_SKIPPED_TYPES = 25;
const REDACTED = '[redacted]';

/**
 * Payment-account ledger types recorded as `fee` entries (keys are ledger_type lower-cased with
 * runs of other characters turned into `_`). Deliberately conservative: only DEBITS whose type
 * names an Etsy selling fee (transaction, processing, listing/renewal, Offsite Ads). Everything
 * else is skipped and counted per type in the sync result: sales credits and refunds (revenue and
 * refunds come from receipts, so nothing is counted twice), fee credits/reversals (the ledger has
 * no negative-fee kind, so skipping them can only understate net), deposits, VAT on fees, Etsy Ads,
 * shipping labels, subscriptions and unknown types. The spec enumerates no ledger_type values;
 * these follow Etsy's billing vocabulary and must be re-verified against a real shop's ledger
 * (the skippedTypes of each sync show exactly what was left out).
 */
export const ETSY_FEE_LEDGER_TYPES = Object.freeze({
  transaction: 'transaction fee',
  transaction_fee: 'transaction fee',
  shipping_transaction: 'transaction fee on shipping',
  payment_processing_fee: 'payment processing fee',
  processing_fee: 'payment processing fee',
  listing: 'listing fee',
  listing_fee: 'listing fee',
  transaction_quantity: 'listing fee (multi-quantity sale)',
  renew: 'listing renewal fee',
  renew_sold: 'listing renewal fee',
  renew_sold_auto: 'listing renewal fee',
  renew_expired: 'listing renewal fee',
  renew_expired_auto: 'listing renewal fee',
  offsite_ads_fee: 'Offsite Ads fee',
});

/** Receipt statuses after which a refund is expected; such receipts were paid. */
const REFUNDED_STATUSES = new Set(['fully refunded', 'partially refunded']);
/** Receipt statuses whose counted revenue must net to zero. */
const NET_ZERO_STATUSES = new Set(['fully refunded', 'canceled']);

const clip = (s, max) => {
  const text = String(s ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function cents(money, field) {
  if (money == null) return { cents: 0, currency: null };
  const { amount, divisor, currency_code: currency } = money;
  if (!Number.isFinite(amount) || !Number.isFinite(divisor) || divisor <= 0) throw new Error(`malformed money in ${field}`);
  return { cents: Math.round((amount * 100) / divisor), currency: currency || null };
}

function receiptStatus(receipt) {
  return typeof receipt.status === 'string' ? receipt.status.trim().toLowerCase() : '';
}

/**
 * Ledger entries a receipt proves that are not recorded yet: revenue when paid, plus refunds.
 * Refunds are capped so a receipt never nets below zero (Etsy's refund total can include sales tax,
 * which revenue excludes), and a "fully refunded" or "canceled" receipt whose listed refunds do
 * not cover its counted revenue gets one balancing refund (`refund:<id>:balance`) so it nets to
 * exactly zero. A canceled receipt seen for the first time is not counted at all.
 * Pure (apart from fresh entry ids) so a sync can convert everything before appending anything.
 * @param {object} receipt Etsy ShopReceipt
 * @param {string} shopId
 * @param {{revenueCents?:number|null, currency?:string|null, refundedCents?:number, refundIds?:Set<string>}} [prior]
 *   what the ledger already holds for this receipt (see recordedReceipts)
 */
export function receiptEntries(receipt, shopId, prior = {}) {
  const id = receipt.receipt_id;
  const url = `${ETSY_API_BASE}/shops/${shopId}/receipts/${id}`;
  const status = receiptStatus(receipt);
  const refundIds = prior.refundIds ?? new Set();
  const entries = [];
  let base = prior.revenueCents ?? null; // revenue this receipt counts in the ledger
  let currency = prior.currency ?? null;

  const countable = status !== 'canceled' && (receipt.is_paid === true || REFUNDED_STATUSES.has(status));
  if (base === null && countable) {
    const items = cents(receipt.total_price, 'total_price');
    const shipping = cents(receipt.total_shipping_cost, 'total_shipping_cost');
    const discount = cents(receipt.discount_amt, 'discount_amt');
    const currencies = new Set([items.currency, shipping.currency, discount.currency].filter(Boolean));
    if (currencies.size !== 1) throw new Error(`receipt ${id}: expected one currency, got ${[...currencies].join(', ') || 'none'}`);
    const amountCents = items.cents + shipping.cents - discount.cents;
    if (amountCents > 0) {
      currency = [...currencies][0];
      base = amountCents;
      entries.push({
        entryId: newId('led'),
        kind: 'revenue',
        amountCents,
        currency,
        stream: 'etsy',
        provenance: 'connector',
        source: { connector: 'etsy', externalId: `receipt:${id}`, url },
        occurredAt: new Date(receipt.create_timestamp * 1000).toISOString(),
        memo: `Etsy receipt ${id}: items ${items.cents}¢ + shipping ${shipping.cents}¢ - discounts ${discount.cents}¢ (sales tax and VAT excluded)${status ? `; status "${status}"` : ''}`,
      });
    }
  }
  base ??= 0;

  let refunded = prior.refundedCents ?? 0;
  const refunds = [...(receipt.refunds || [])].sort((a, b) => (a?.created_timestamp ?? 0) - (b?.created_timestamp ?? 0));
  for (const refund of refunds) {
    const amount = cents(refund.amount, 'refunds[].amount');
    if (amount.cents <= 0) continue;
    // Etsy refunds have no id; receipt + time + amount identifies one stably across syncs.
    const at = refund.created_timestamp ?? receipt.update_timestamp;
    const externalId = `refund:${id}:${at}:${refund.amount.amount}`;
    if (refundIds.has(externalId)) continue;
    const headroom = Math.max(0, base - refunded);
    const take = Math.min(amount.cents, headroom);
    if (take <= 0) continue; // nothing counted is left to refund against
    if (currency && amount.currency && amount.currency !== currency) {
      throw new Error(`receipt ${id}: refund in ${amount.currency} against revenue in ${currency}`);
    }
    refunded += take;
    entries.push({
      entryId: newId('led'),
      kind: 'refund',
      amountCents: take,
      currency: currency || amount.currency || 'USD',
      stream: 'etsy',
      provenance: 'connector',
      source: { connector: 'etsy', externalId, url },
      occurredAt: new Date(at * 1000).toISOString(),
      memo: `Etsy refund on receipt ${id}${refund.status ? ` (${refund.status})` : ''}${refund.reason ? `: ${refund.reason}` : ''}${take < amount.cents ? ` [Etsy reported ${amount.cents}¢; capped at the ${base}¢ this receipt counts, which excludes tax]` : ''}`,
    });
  }

  const balanceId = `refund:${id}:balance`;
  if (NET_ZERO_STATUSES.has(status) && base - refunded > 0 && !refundIds.has(balanceId)) {
    const at = receipt.update_timestamp ?? receipt.create_timestamp;
    entries.push({
      entryId: newId('led'),
      kind: 'refund',
      amountCents: base - refunded,
      currency: currency || 'USD',
      stream: 'etsy',
      provenance: 'connector',
      source: { connector: 'etsy', externalId: balanceId, url },
      occurredAt: new Date(at * 1000).toISOString(),
      memo: `Etsy receipt ${id} is "${status}": the refunds Etsy lists cover ${refunded}¢ of the ${base}¢ counted, so the remaining ${base - refunded}¢ is reversed and the receipt nets to zero`,
    });
  }
  return entries;
}

/**
 * What the ledger already holds per Etsy receipt id (counted revenue, refunds recorded).
 * @param {{entries:object, entryOrder:string[]}} ledger store.state.ledger
 * @returns {Map<string, {revenueCents:number|null, currency:string|null, refundedCents:number, refundIds:Set<string>}>}
 */
export function recordedReceipts(ledger) {
  const byReceipt = new Map();
  for (const entryId of ledger.entryOrder) {
    const e = ledger.entries[entryId];
    if (e?.source?.connector !== 'etsy' || typeof e.source.externalId !== 'string') continue;
    const m = /^(receipt|refund):([^:]+)/.exec(e.source.externalId);
    if (!m) continue;
    const r = byReceipt.get(m[2]) ?? { revenueCents: null, currency: null, refundedCents: 0, refundIds: new Set() };
    if (m[1] === 'receipt' && e.kind === 'revenue') {
      r.revenueCents = e.amountCents;
      r.currency = e.currency;
    } else if (m[1] === 'refund' && e.kind === 'refund') {
      r.refundedCents += e.amountCents;
      r.refundIds.add(e.source.externalId);
    }
    byReceipt.set(m[2], r);
  }
  return byReceipt;
}

function ledgerType(raw) {
  return typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) : '';
}

/**
 * One payment-account ledger line -> `{ entry }` (a connector `fee`) or `{ skipped: <type> }`.
 * Only fee-typed lines are shape-checked (a malformed one throws, failing the whole sync);
 * everything else is skipped unread.
 */
export function ledgerFeeEntry(raw, shopId) {
  const type = ledgerType(raw?.ledger_type);
  if (!type || !Object.hasOwn(ETSY_FEE_LEDGER_TYPES, type)) return { skipped: type || 'untyped' };
  const id = raw.entry_id;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`ledger entry (${type}): malformed entry_id`);
  if (!Number.isSafeInteger(raw.amount)) throw new Error(`ledger entry ${id}: malformed amount`);
  if (typeof raw.currency !== 'string' || !/^[A-Za-z]{3}$/.test(raw.currency)) throw new Error(`ledger entry ${id}: malformed currency`);
  const at = raw.created_timestamp ?? raw.create_date;
  if (!Number.isFinite(at)) throw new Error(`ledger entry ${id}: malformed created_timestamp`);
  if (raw.amount === 0) return { skipped: `${type} (zero)` };
  if (raw.amount > 0) return { skipped: `${type} (credit)` }; // a fee reversal: there is no negative-fee kind
  const label = ETSY_FEE_LEDGER_TYPES[type];
  const ref = raw.reference_type ? `; ${clip(raw.reference_type, 30)} ${clip(raw.reference_id ?? '', 30)}`.trimEnd() : '';
  return {
    entry: {
      entryId: newId('led'),
      kind: 'fee',
      amountCents: -raw.amount,
      currency: raw.currency.toUpperCase(),
      stream: 'etsy',
      provenance: 'connector',
      source: { connector: 'etsy', externalId: `ledger:${id}`, url: `${ETSY_API_BASE}/shops/${shopId}/payment-account/ledger-entries` },
      occurredAt: new Date(at * 1000).toISOString(),
      memo: `Etsy ${label} (payment-account ledger entry ${id}, ledger_type "${clip(raw.ledger_type, 40)}"${ref})${raw.description ? `: ${clip(raw.description, 120)}` : ''}`,
    },
  };
}

/** Classify a page set of ledger lines: fee entries to record, and what was skipped, by type. */
export function ledgerFees(rawEntries, shopId) {
  const entries = [];
  const skippedTypes = {};
  let skipped = 0;
  for (const raw of rawEntries) {
    const result = ledgerFeeEntry(raw, shopId);
    if (result.entry) {
      entries.push(result.entry);
      continue;
    }
    skipped += 1;
    const key = Object.hasOwn(skippedTypes, result.skipped) || Object.keys(skippedTypes).length < MAX_SKIPPED_TYPES ? result.skipped : 'other';
    skippedTypes[key] = (skippedTypes[key] || 0) + 1;
  }
  return { entries, skipped, skippedTypes };
}

// ---- token persistence ---------------------------------------------------------------------

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/**
 * Read a persisted token pair, or null when absent, unreadable, or seeded from a different
 * ETSY_REFRESH_TOKEN than the one in the environment now (the operator re-authorized).
 * Never logs file contents: a JSON parse error message can quote them.
 */
function loadTokenFile(path, envRefreshToken, warn) {
  if (!path || !existsSync(path)) return null;
  try {
    if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
    const j = JSON.parse(readFileSync(path, 'utf8'));
    if (j?.schema !== TOKEN_FILE_SCHEMA || typeof j.access_token !== 'string' || !j.access_token || typeof j.refresh_token !== 'string' || !j.refresh_token) {
      warn(`ignoring ${path}: not an Outpost Etsy token file`);
      return null;
    }
    if (envRefreshToken && j.seed_sha256 !== sha256(envRefreshToken)) {
      warn(`ETSY_REFRESH_TOKEN changed since ${path} was written; using the token from the environment`);
      return null;
    }
    const expiresAt = typeof j.expires_at === 'string' ? Date.parse(j.expires_at) : NaN;
    return { access: j.access_token, refresh: j.refresh_token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, seed: j.seed_sha256 ?? null };
  } catch (err) {
    warn(`cannot read ${path} (${err.code || 'unparseable'}); using the token from the environment`);
    return null;
  }
}

/** Atomic, owner-only write: 0600 temp file, fsync, rename. */
function writeTokenFile(path, data) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort: the file itself is 0600 either way
  }
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already failing; keep the original error
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
}

function etsyErrorText(text) {
  let detail = text;
  try {
    const j = JSON.parse(text);
    detail = j.error_description || j.error || text;
  } catch {
    // not JSON; keep the raw text
  }
  return clip(typeof detail === 'string' ? detail : JSON.stringify(detail), 1000);
}

const defaultLog = (msg) => console.error(`outpost etsy: ${msg}`);

/**
 * @param {{apiKey?:string|null, sharedSecret?:string|null, accessToken?:string|null, refreshToken?:string|null,
 *   shopId?:string|null, taxonomyId?:number|string|null, shippingProfileId?:number|string|null,
 *   tokenFile?:string|null, fetchImpl?:typeof fetch, now?:() => number, log?:(msg:string) => void,
 *   feeLookbackDays?:number}} opts
 *   tokenFile: where rotated tokens are persisted (index.js: <dataDir>/secrets/etsy-token.json);
 *   null keeps them in memory only.
 */
export function createEtsyConnector({
  apiKey, sharedSecret, accessToken, refreshToken = null, shopId, taxonomyId = null, shippingProfileId = null,
  tokenFile = null, fetchImpl = fetch, now = Date.now, log = defaultLog, feeLookbackDays = 90,
} = {}) {
  const seen = new Set();
  // A value under 4 characters is not a credential Etsy issues, and replacing every occurrence of
  // it would shred the message rather than protect anything.
  const remember = (secret) => {
    if (secret && String(secret).length >= 4) seen.add(String(secret));
  };
  [apiKey, sharedSecret, accessToken, refreshToken].forEach(remember);
  /**
   * One pass (longest secret first), and existing markers are left intact, so a marker is never
   * re-redacted and redacting twice changes nothing.
   */
  const redact = (s) => {
    if (!seen.size) return String(s);
    const any = new RegExp([...seen].sort((a, b) => b.length - a.length).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    return String(s).split(REDACTED).map((part) => part.replace(any, REDACTED)).join(REDACTED);
  };
  const warn = (msg) => log(redact(msg));

  const saved = loadTokenFile(tokenFile, refreshToken, warn);
  const token = saved
    ? { access: saved.access, refresh: saved.refresh, expiresAt: saved.expiresAt, source: 'file' }
    : { access: accessToken || null, refresh: refreshToken || null, expiresAt: null, source: accessToken || refreshToken ? 'env' : null };
  remember(token.access);
  remember(token.refresh);
  const seed = saved ? saved.seed : refreshToken ? sha256(refreshToken) : null;
  // The shared secret is part of the required x-api-key header, so it is required here too; a
  // refresh token alone is enough to obtain an access token.
  const configured = Boolean(apiKey && sharedSecret && shopId && (token.access || token.refresh));
  let refreshing = null;

  function persist() {
    if (!tokenFile) return;
    try {
      writeTokenFile(tokenFile, {
        schema: TOKEN_FILE_SCHEMA,
        access_token: token.access,
        refresh_token: token.refresh,
        expires_at: token.expiresAt ? new Date(token.expiresAt).toISOString() : null,
        refreshed_at: new Date(now()).toISOString(),
        seed_sha256: seed,
      });
    } catch (err) {
      warn(`could not save the rotated Etsy token to ${tokenFile} (${err.code || 'write error'}); it is held in memory only, so re-authorize after a restart if Etsy revoked the old refresh token`);
    }
  }

  async function doRefresh() {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: apiKey, refresh_token: token.refresh });
    let res;
    let text;
    try {
      res = await fetchImpl(ETSY_TOKEN_URL, {
        method: 'POST',
        headers: { 'x-api-key': `${apiKey}:${sharedSecret}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
      });
      text = await res.text();
    } catch (err) {
      throw new Error(redact(`Etsy token refresh failed: ${err.message}`));
    }
    if (!res.ok) {
      throw new Error(redact(`Etsy token refresh failed with HTTP ${res.status}: ${etsyErrorText(text).replace(/[.\s]+$/, '')}. Re-authorize Outpost on Etsy, set the new ETSY_REFRESH_TOKEN and restart the sidecar.`));
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error('Etsy token refresh returned a non-JSON response');
    }
    if (typeof j?.access_token !== 'string' || !j.access_token) throw new Error('Etsy token refresh response has no access_token');
    remember(j.access_token);
    token.access = j.access_token;
    if (typeof j.refresh_token === 'string' && j.refresh_token) {
      remember(j.refresh_token);
      token.refresh = j.refresh_token; // Etsy rotates it: the old one is now spent
    }
    token.expiresAt = Number.isFinite(j.expires_in) && j.expires_in > 0 ? now() + j.expires_in * 1000 : null;
    token.source = 'refresh';
    persist();
  }

  /** Single flight: concurrent 401s share one refresh (a second one would spend a rotated token). */
  function refresh() {
    refreshing ??= doRefresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  const needsRefresh = () => Boolean(token.refresh) && (!token.access || (token.expiresAt !== null && now() >= token.expiresAt - REFRESH_EARLY_MS));

  /**
   * One request, bounded by a deadline and by the caller's signal (a run's E-STOP / cancel). The
   * token refresh is deliberately NOT tied to the caller's signal: Etsy rotates the refresh token,
   * so abandoning a refresh mid-flight could lose the only valid one.
   */
  function send(method, url, body, access, { signal, timeoutMs = ETSY_REQUEST_TIMEOUT_MS } = {}) {
    signal?.throwIfAborted();
    const headers = { 'x-api-key': `${apiKey}:${sharedSecret}`, accept: 'application/json' };
    if (access) headers.authorization = `Bearer ${access}`;
    if (body instanceof URLSearchParams) headers['content-type'] = 'application/x-www-form-urlencoded';
    return fetchImpl(url, { method, headers, body, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)) });
  }

  async function call(method, path, { query, body, signal, timeoutMs } = {}) {
    if (!configured) throw new Error('etsy connector not configured');
    const url = new URL(`${ETSY_API_BASE}${path}`);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
    if (needsRefresh()) await refresh();
    let used = token.access;
    let res = await send(method, url.toString(), body, used, { signal, timeoutMs });
    if (res.status === 401 && token.refresh) {
      await res.text().catch(() => '');
      if (token.access === used) await refresh(); // else another call already refreshed it
      used = token.access;
      res = await send(method, url.toString(), body, used, { signal, timeoutMs }); // one retry, never more
    }
    const text = await res.text();
    if (!res.ok) throw new Error(redact(`Etsy API ${method} ${path} failed with HTTP ${res.status}: ${etsyErrorText(text)}`));
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Etsy API ${method} ${path} returned a non-JSON response`);
    }
  }

  /** Every result from `offset` on, page by page (limit clamped to 1..100). Stops between pages on abort. */
  async function fetchAll(path, query, { limit = PAGE_MAX, offset = 0, signal } = {}) {
    const pageSize = Math.min(PAGE_MAX, Math.max(1, Math.floor(limit)));
    const out = [];
    for (let at = offset; ;) {
      signal?.throwIfAborted();
      const page = await call('GET', path, { query: { limit: pageSize, offset: at, ...query }, signal });
      const results = Array.isArray(page?.results) ? page.results : [];
      out.push(...results);
      at += results.length;
      if (results.length < pageSize || (Number.isFinite(page?.count) && at >= page.count)) return out;
    }
  }

  /** All receipts from `offset` on, page by page. `minCreated` is epoch seconds. */
  function fetchReceipts({ limit = PAGE_MAX, offset = 0, minCreated, signal } = {}) {
    return fetchAll(`/shops/${shopId}/receipts`, { min_created: minCreated }, { limit, offset, signal });
  }

  /** Payment-account ledger lines created in [minCreated, maxCreated] (epoch seconds, both required). */
  function fetchLedgerEntries({ minCreated, maxCreated, limit = PAGE_MAX, offset = 0, signal } = {}) {
    if (!Number.isSafeInteger(minCreated) || !Number.isSafeInteger(maxCreated)) {
      return Promise.reject(new Error('fetchLedgerEntries needs integer minCreated and maxCreated (epoch seconds)'));
    }
    return fetchAll(`/shops/${shopId}/payment-account/ledger-entries`, { min_created: minCreated, max_created: maxCreated }, { limit, offset, signal });
  }

  /** maxCreated of the last successful sync that read fees, from the log (null if none). */
  function lastFeeWindowEnd(store) {
    const events = store.events();
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e.type === 'connector.sync' && e.payload.connector === 'etsy' && e.payload.ok && Number.isSafeInteger(e.payload.fees?.maxCreated)) {
        return e.payload.fees.maxCreated;
      }
    }
    return null;
  }

  /**
   * Fee window: from the end of the last successful fee sync (minus a day of overlap) or, on the
   * first one, `feeLookbackDays` back; always reaching back to the oldest receipt this sync
   * newly counts, so no counted revenue lacks its fees.
   */
  function feeWindow(store, oldestNewReceipt) {
    const maxCreated = Math.floor(now() / 1000);
    const last = lastFeeWindowEnd(store);
    let minCreated = last !== null ? last - FEE_WINDOW_OVERLAP_S : maxCreated - Math.round(feeLookbackDays * DAY_S);
    if (Number.isFinite(oldestNewReceipt)) minCreated = Math.min(minCreated, Math.floor(oldestNewReceipt));
    minCreated = Math.max(ETSY_MIN_TIMESTAMP, Math.min(minCreated, maxCreated - 1));
    return { minCreated, maxCreated };
  }

  async function collectFees(store, oldestNewReceipt, signal) {
    const window = feeWindow(store, oldestNewReceipt);
    const lines = await fetchLedgerEntries({ ...window, signal });
    const { entries, skipped, skippedTypes } = ledgerFees(lines, shopId);
    return { entries, summary: { fetched: lines.length, feeLines: entries.length, newEntries: 0, skipped, skippedTypes, ...window } };
  }

  /** Append the entries the ledger does not hold yet; returns how many were new. */
  function appendNew(store, entries) {
    let added = 0;
    for (const entry of entries) {
      if (store.state.ledger.externalIds[`etsy:${entry.source.externalId}`]) continue; // already counted
      store.append('ledger.entry', entry, ACTOR);
      added += 1;
    }
    return added;
  }

  // Syncs run one at a time (an operator click and an agent's sync_connector can overlap): each
  // reads what the ledger holds to cap refunds and to place the fee window, so the second one must
  // start from what the first recorded.
  let syncQueue = Promise.resolve();
  function serialized(fn) {
    const run = syncQueue.then(fn, fn);
    syncQueue = run.catch(() => {});
    return run;
  }

  function failed(store, err, fetched) {
    const error = redact(err.message);
    store.append('connector.sync', { connector: 'etsy', ok: false, fetched, newEntries: 0, error }, ACTOR);
    return new Error(error);
  }

  /**
   * Full sync: receipts (revenue and refunds) AND payment-account fees, so the counted net is not
   * overstated. All-or-nothing: if either fetch or any conversion fails, nothing is appended and
   * connector.sync ok:false is logged. `fetched` counts receipts; fee lines are under `fees`.
   * @returns {Promise<{fetched:number, newEntries:number, receipts:{fetched:number, newEntries:number},
   *   fees:{fetched:number, feeLines:number, newEntries:number, skipped:number, skippedTypes:object, minCreated:number, maxCreated:number}}>}
   */
  function syncRevenue(store, { signal } = {}) {
    return serialized(() => runSyncRevenue(store, signal));
  }

  async function runSyncRevenue(store, signal) {
    let receipts = null;
    let receiptNew;
    let fees;
    try {
      receipts = await fetchReceipts({ signal });
      const prior = recordedReceipts(store.state.ledger);
      receiptNew = [];
      let oldestNew = Infinity;
      for (const r of receipts) {
        const entries = receiptEntries(r, shopId, prior.get(String(r.receipt_id)));
        if (Number.isFinite(r.create_timestamp) && entries.some((e) => e.kind === 'revenue')) oldestNew = Math.min(oldestNew, r.create_timestamp);
        receiptNew.push(...entries);
      }
      fees = await collectFees(store, oldestNew, signal);
    } catch (err) {
      throw failed(store, err, receipts?.length ?? 0);
    }
    const receiptCount = appendNew(store, receiptNew);
    fees.summary.newEntries = appendNew(store, fees.entries);
    const summary = {
      fetched: receipts.length,
      newEntries: receiptCount + fees.summary.newEntries,
      receipts: { fetched: receipts.length, newEntries: receiptCount },
      fees: fees.summary,
    };
    store.append('connector.sync', { connector: 'etsy', ok: true, ...summary }, ACTOR);
    return summary;
  }

  /** Fees only (getShopPaymentAccountLedgerEntries); same window and all-or-nothing rules. */
  function syncFees(store, { signal } = {}) {
    return serialized(() => runSyncFees(store, signal));
  }

  async function runSyncFees(store, signal) {
    let fees;
    try {
      fees = await collectFees(store, null, signal);
    } catch (err) {
      throw failed(store, err, 0);
    }
    fees.summary.newEntries = appendNew(store, fees.entries);
    store.append('connector.sync', { connector: 'etsy', ok: true, fetched: fees.summary.fetched, newEntries: fees.summary.newEntries, fees: fees.summary }, ACTOR);
    return fees.summary;
  }

  /** Create an Etsy listing in draft state (never activated). `signal` aborts the request (E-STOP). */
  async function createDraftListing(draft, { signal } = {}) {
    if (!taxonomyId) {
      throw new Error('ETSY_TAXONOMY_ID is not set: Etsy needs a seller taxonomy id (the product category) for every listing. Set it and retry.');
    }
    const form = new URLSearchParams({
      quantity: String(draft.quantity),
      title: draft.title,
      description: draft.description,
      price: String(draft.price),
      who_made: draft.who_made,
      when_made: draft.when_made,
      taxonomy_id: String(taxonomyId),
      is_supply: String(Boolean(draft.is_supply)),
    });
    if (draft.tags?.length) form.set('tags', draft.tags.join(','));
    if (Array.isArray(draft.production_partner_ids) && draft.production_partner_ids.length) {
      form.set('production_partner_ids', draft.production_partner_ids.join(','));
    }
    if (shippingProfileId) form.set('shipping_profile_id', String(shippingProfileId));
    let listing;
    try {
      listing = await call('POST', `/shops/${shopId}/listings`, { body: form, signal });
    } catch (err) {
      // Etsy's own words stay verbatim in err.message; only add the setting that would fix it.
      if (!shippingProfileId && /shipping/i.test(err.message)) {
        throw new Error(`${err.message} (ETSY_SHIPPING_PROFILE_ID is not set: set it to one of the shop's shipping profile ids and retry)`);
      }
      throw err;
    }
    if (!listing?.listing_id) throw new Error('Etsy createDraftListing response has no listing_id');
    return { listingId: listing.listing_id, url: listing.url || `https://www.etsy.com/listing/${listing.listing_id}` };
  }

  /** Attach a PNG or JPEG to a listing. `signal` aborts the upload (E-STOP). */
  async function uploadListingImage(listingId, buffer, filename, { signal } = {}) {
    const mime = sniffImageMime(buffer);
    if (mime !== 'image/png' && mime !== 'image/jpeg') {
      throw new Error('Etsy listing images must be PNG or JPEG here (SVG is not accepted): rasterize the design first');
    }
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: mime }), filename);
    const image = await call('POST', `/shops/${shopId}/listings/${listingId}/images`, { body: form, signal, timeoutMs: ETSY_UPLOAD_TIMEOUT_MS });
    return { imageId: image?.listing_image_id ?? null };
  }

  /** Token facts safe to show anywhere (no token material). */
  function tokenStatus() {
    return {
      source: token.source,
      refreshable: Boolean(token.refresh),
      expiresAt: token.expiresAt ? new Date(token.expiresAt).toISOString() : null,
      persisted: Boolean(tokenFile),
    };
  }

  return {
    configured,
    fetchReceipts,
    fetchLedgerEntries,
    syncRevenue,
    sync: syncRevenue,
    syncFees,
    createDraftListing,
    uploadListingImage,
    tokenStatus,
    redact,
  };
}
