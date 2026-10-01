// Ledger tools. Counted totals come only from the projector (connector + operator entries);
// agents can add claims, which are shown but never summed, and can pull verified revenue
// from a configured connector.

import { coverageCaveat, evidenceCoverage, netCents } from '../../shared/projector.js';
import { ETSY_SETUP_HINT } from '../connectors/etsy.js';
import { newId } from '../ids.js';

export const CLAIMS_EXCLUDED_NOTE =
  'Counted totals include only connector-verified revenue (fetched from a platform API) and operator-entered amounts. ' +
  'Agent claims are listed separately as claimed_revenue_usd and are never added to any total.';
export const ETSY_NOT_CONFIGURED = `etsy connector not configured: ${ETSY_SETUP_HINT}`;

const usd = (cents) => Math.round(cents) / 100;

function totalsView(t) {
  return {
    verified_revenue_usd: usd(t.verifiedRevenueCents),
    operator_revenue_usd: usd(t.operatorRevenueCents),
    claimed_revenue_usd: usd(t.claimedRevenueCents),
    fees_usd: usd(t.feesCents),
    costs_usd: usd(t.costCents),
    net_counted_usd: usd(netCents(t)),
    verified_orders: t.verifiedOrders,
    operator_orders: t.operatorOrders,
  };
}

/** Entries in other currencies: never added to the USD totals, reported in their own units. */
function unconvertedView(unconverted = {}) {
  return Object.fromEntries(Object.entries(unconverted).map(([currency, t]) => [currency, {
    entries: t.entries,
    verified_revenue: usd(t.verifiedRevenueCents),
    operator_revenue: usd(t.operatorRevenueCents),
    claimed_revenue: usd(t.claimedRevenueCents),
    fees: usd(t.feesCents),
    costs: usd(t.costCents),
  }]));
}

/** read_ledger: totals by provenance and stream, evidence coverage, runtime spend. */
export async function readLedger(_input, ctx) {
  const { ledger, spend, connectors } = ctx.store.state;
  const today = new Date().toISOString().slice(0, 10);
  const coverage = evidenceCoverage(ledger.totals);
  const caveat = coverageCaveat(ledger.totals);
  const unconverted = unconvertedView(ledger.unconverted);
  const output = {
    totals: totalsView(ledger.totals),
    // Floored, never rounded up: the share backed by a connector is not overstated.
    evidence_coverage: coverage === null ? null : Math.floor(coverage * 1000) / 1000,
    by_stream: Object.fromEntries(Object.entries(ledger.byStream).map(([stream, t]) => [stream, totalsView(t)])),
    entries: ledger.entryOrder.length,
    runtime_spend_usd: { total: spend.totalUsd, today: spend.byDay[today] || 0, today_utc_date: today },
    connectors,
    note: `${CLAIMS_EXCLUDED_NOTE} All *_usd figures are US dollars only. evidence_coverage is the share of counted revenue backed by a connector (null when nothing is counted). runtime_spend_usd is model and image spend, reported separately from net.`,
  };
  if (caveat) output.evidence_coverage_note = `n/a as a plain share: ${caveat}`;
  if (Object.keys(unconverted).length) {
    output.unconverted = unconverted;
    output.unconverted_note = 'Entries in other currencies, in their own units. Nothing converts currencies, so they are NOT in any *_usd total above.';
  }
  return { ok: true, output };
}

/** record_ledger_claim: an agent_claim entry, displayed but never counted. */
export async function recordLedgerClaim(input, ctx) {
  const amountCents = Math.round(input.amount_usd * 100);
  if (!(amountCents > 0)) return { ok: false, output: 'amount_usd must be at least 0.01 (the kind sets the sign)' };
  if (!input.source_note.trim()) return { ok: false, output: 'source_note is required: say where the figure came from' };
  if (!input.stream.trim()) return { ok: false, output: 'stream is required (e.g. etsy, fiverr, assets)' };
  const entryId = newId('led');
  ctx.store.append('ledger.entry', {
    entryId,
    kind: input.kind,
    amountCents,
    currency: 'USD',
    stream: input.stream.trim(),
    provenance: 'agent_claim',
    source: { note: input.source_note.trim() },
    occurredAt: new Date().toISOString(),
    memo: input.memo,
  }, ctx.agent.id);
  return { ok: true, output: `Recorded claim ${entryId}: ${input.kind} $${usd(amountCents).toFixed(2)} (${input.stream.trim()}). It is shown as an unverified agent claim and excluded from all counted totals.` };
}

/** sync_connector: pull verified revenue from a configured platform connector. */
export async function syncConnector(_input, ctx) {
  const etsy = ctx.connectors?.etsy; // the schema's enum admits only 'etsy'
  if (!etsy?.configured) return { ok: false, output: ETSY_NOT_CONFIGURED };
  try {
    const res = await etsy.syncRevenue(ctx.store, { signal: ctx.signal });
    const plural = (n) => `entr${n === 1 ? 'y' : 'ies'}`;
    const r = res.receipts ?? { fetched: res.fetched, newEntries: res.newEntries };
    const fees = res.fees ? `; fees: ${res.fees.fetched} payment-account ledger line(s) read, ${res.fees.newEntries} new fee ${plural(res.fees.newEntries)}` : '';
    return { ok: true, output: `Etsy sync: receipts: ${r.fetched} fetched, ${r.newEntries} new verified ${plural(r.newEntries)}${fees} (already-recorded items are skipped).` };
  } catch (err) {
    return { ok: false, output: `Etsy sync failed: ${err.message}` };
  }
}
