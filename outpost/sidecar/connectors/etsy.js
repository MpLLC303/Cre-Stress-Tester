// Etsy Open API v3 connector: the only source of `connector`-provenance revenue for the Etsy stream.
//
// Verified against Etsy's API (2026):
// - every request sends `x-api-key: <keystring>:<shared_secret>` (shared secret enforced since
//   2026-02-09, github.com/etsy/open-api/discussions/1521) plus `Authorization: Bearer <token>`;
// - getShopReceipts: GET /shops/{shop_id}/receipts, limit 1..100 + offset, response {count, results};
// - Money is {amount, divisor, currency_code}; `subtotal` is already net of coupon discounts, so
//   revenue is computed from `total_price` (items) + `total_shipping_cost` - `discount_amt`,
//   which excludes `total_tax_cost`/`total_vat_cost` (tax collected for remittance);
// - receipts carry `refunds` (amount, created_timestamp, reason, status; no refund id);
// - createDraftListing: POST /shops/{shop_id}/listings, form-encoded, array fields comma-joined;
// - uploadListingImage: POST /shops/{shop_id}/listings/{listing_id}/images, multipart `image`
//   (JPG/PNG/GIF; SVG is not accepted).
// Fees are not recorded: they exist only in the payment-account ledger, which this connector does
// not read, and Outpost never estimates them.

import { newId } from '../ids.js';
import { sniffImageMime } from '../images.js';

export const ETSY_API_BASE = 'https://openapi.etsy.com/v3/application';
const PAGE_MAX = 100;
const ACTOR = 'connector:etsy';

function cents(money, field) {
  if (money == null) return { cents: 0, currency: null };
  const { amount, divisor, currency_code: currency } = money;
  if (!Number.isFinite(amount) || !Number.isFinite(divisor) || divisor <= 0) throw new Error(`malformed money in ${field}`);
  return { cents: Math.round((amount * 100) / divisor), currency: currency || null };
}

/**
 * Ledger entries a receipt proves: revenue when paid, plus one refund entry per refund.
 * Pure (apart from fresh entry ids) so a sync can convert everything before appending anything.
 */
export function receiptEntries(receipt, shopId) {
  const id = receipt.receipt_id;
  const url = `${ETSY_API_BASE}/shops/${shopId}/receipts/${id}`;
  const entries = [];
  if (receipt.is_paid === true) {
    const items = cents(receipt.total_price, 'total_price');
    const shipping = cents(receipt.total_shipping_cost, 'total_shipping_cost');
    const discount = cents(receipt.discount_amt, 'discount_amt');
    const currencies = new Set([items.currency, shipping.currency, discount.currency].filter(Boolean));
    if (currencies.size !== 1) throw new Error(`receipt ${id}: expected one currency, got ${[...currencies].join(', ') || 'none'}`);
    const amountCents = items.cents + shipping.cents - discount.cents;
    if (amountCents > 0) {
      entries.push({
        entryId: newId('led'),
        kind: 'revenue',
        amountCents,
        currency: [...currencies][0],
        stream: 'etsy',
        provenance: 'connector',
        source: { connector: 'etsy', externalId: `receipt:${id}`, url },
        occurredAt: new Date(receipt.create_timestamp * 1000).toISOString(),
        memo: `Etsy receipt ${id}: items ${items.cents}¢ + shipping ${shipping.cents}¢ - discounts ${discount.cents}¢ (sales tax and VAT excluded)`,
      });
    }
  }
  for (const refund of receipt.refunds || []) {
    const amount = cents(refund.amount, 'refunds[].amount');
    if (amount.cents <= 0) continue;
    // Etsy refunds have no id; receipt + time + amount identifies one stably across syncs.
    const at = refund.created_timestamp ?? receipt.update_timestamp;
    entries.push({
      entryId: newId('led'),
      kind: 'refund',
      amountCents: amount.cents,
      currency: amount.currency || 'USD',
      stream: 'etsy',
      provenance: 'connector',
      source: { connector: 'etsy', externalId: `refund:${id}:${at}:${refund.amount.amount}`, url },
      occurredAt: new Date(at * 1000).toISOString(),
      memo: `Etsy refund on receipt ${id}${refund.status ? ` (${refund.status})` : ''}${refund.reason ? `: ${refund.reason}` : ''}`,
    });
  }
  return entries;
}

/**
 * @param {{apiKey?:string|null, sharedSecret?:string|null, accessToken?:string|null, shopId?:string|null,
 *   taxonomyId?:string|number|null, fetchImpl?:typeof fetch}} opts
 */
export function createEtsyConnector({ apiKey, sharedSecret, accessToken, shopId, taxonomyId = null, fetchImpl = fetch } = {}) {
  // The shared secret is part of the required x-api-key header, so it is required here too.
  const configured = Boolean(apiKey && sharedSecret && accessToken && shopId);
  const secrets = [apiKey, sharedSecret, accessToken].filter(Boolean);
  const redact = (s) => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), String(s));

  async function call(method, path, { query, body } = {}) {
    if (!configured) throw new Error('etsy connector not configured');
    const url = new URL(`${ETSY_API_BASE}${path}`);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
    const headers = { 'x-api-key': `${apiKey}:${sharedSecret}`, authorization: `Bearer ${accessToken}`, accept: 'application/json' };
    if (body instanceof URLSearchParams) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetchImpl(url.toString(), { method, headers, body });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const j = JSON.parse(text);
        detail = j.error_description || j.error || text;
      } catch {
        // not JSON; keep the raw text
      }
      throw new Error(redact(`Etsy API ${method} ${path} failed with HTTP ${res.status}: ${String(detail).slice(0, 300)}`));
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Etsy API ${method} ${path} returned a non-JSON response`);
    }
  }

  /** All receipts from `offset` on, page by page. `minCreated` is epoch seconds. */
  async function fetchReceipts({ limit = PAGE_MAX, offset = 0, minCreated } = {}) {
    const pageSize = Math.min(PAGE_MAX, Math.max(1, Math.floor(limit)));
    const receipts = [];
    for (let at = offset; ;) {
      const page = await call('GET', `/shops/${shopId}/receipts`, { query: { limit: pageSize, offset: at, min_created: minCreated } });
      const results = Array.isArray(page?.results) ? page.results : [];
      receipts.push(...results);
      at += results.length;
      if (results.length < pageSize || (Number.isFinite(page?.count) && at >= page.count)) return receipts;
    }
  }

  /** Pull receipts and append ledger entries for the ones not yet recorded. */
  async function syncRevenue(store) {
    let receipts;
    let entries;
    try {
      receipts = await fetchReceipts();
      entries = receipts.flatMap((r) => receiptEntries(r, shopId));
    } catch (err) {
      const error = redact(err.message);
      store.append('connector.sync', { connector: 'etsy', ok: false, fetched: receipts?.length ?? 0, newEntries: 0, error }, ACTOR);
      throw new Error(error);
    }
    let newEntries = 0;
    for (const entry of entries) {
      if (store.state.ledger.externalIds[`etsy:${entry.source.externalId}`]) continue; // already counted
      store.append('ledger.entry', entry, ACTOR);
      newEntries += 1;
    }
    store.append('connector.sync', { connector: 'etsy', ok: true, fetched: receipts.length, newEntries }, ACTOR);
    return { fetched: receipts.length, newEntries };
  }

  /** Create an Etsy listing in draft state (never activated). */
  async function createDraftListing(draft) {
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
    const listing = await call('POST', `/shops/${shopId}/listings`, { body: form });
    if (!listing?.listing_id) throw new Error('Etsy createDraftListing response has no listing_id');
    return { listingId: listing.listing_id, url: listing.url || `https://www.etsy.com/listing/${listing.listing_id}` };
  }

  /** Attach a PNG or JPEG to a listing. */
  async function uploadListingImage(listingId, buffer, filename) {
    const mime = sniffImageMime(buffer);
    if (mime !== 'image/png' && mime !== 'image/jpeg') {
      throw new Error('Etsy listing images must be PNG or JPEG here (SVG is not accepted): rasterize the design first');
    }
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: mime }), filename);
    const image = await call('POST', `/shops/${shopId}/listings/${listingId}/images`, { body: form });
    return { imageId: image?.listing_image_id ?? null };
  }

  return { configured, fetchReceipts, syncRevenue, createDraftListing, uploadListingImage };
}
