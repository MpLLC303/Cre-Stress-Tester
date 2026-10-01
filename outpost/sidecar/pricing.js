// Model pricing for cost accounting. Every run.step carries a cost computed here, and budgets
// stop runs on these numbers, so a model without a price can never run.
//
// All token prices are USD per million tokens (MTok), from Anthropic's published pricing
// (https://platform.claude.com/docs/en/about-claude/pricing). When prices change, update this
// table; nothing else in the runtime hard-codes a rate.
//   cacheWrite5m / cacheWrite1h: prompt-cache writes at the 5-minute / 1-hour TTL
//   cacheRead:                   prompt-cache hits
// claude-opus-5 and claude-opus-4-8 are listed because they are the server-side default
// fallback targets for claude-opus-5-5 refusals (`fallbacks: 'default'`), and
// claude-sonnet-5 is the fallback target for claude-sonnet-5-5. A fallback model missing here is
// billed at the highest known rate (see costByModel), never at zero.

export const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  scripted: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
};

/** Server-side web search is billed per request, on top of tokens. */
export const WEB_SEARCH_USD_PER_1K = 10;

const PER_TOKEN = 1 / 1_000_000;

/**
 * Price table entry for a model.
 * @throws {Error} 'no price for model …' when the model is not in PRICES
 */
export function priceFor(model) {
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : null;
  if (!price) throw new Error(`no price for model ${model}`);
  return price;
}

function tokenCost(price, u) {
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const write1h = Math.min(cacheWrite, u.cache_creation?.ephemeral_1h_input_tokens || 0);
  const write5m = cacheWrite - write1h;
  return (
    (u.input_tokens || 0) * price.input +
    (u.output_tokens || 0) * price.output +
    write5m * price.cacheWrite5m +
    write1h * price.cacheWrite1h +
    (u.cache_read_input_tokens || 0) * price.cacheRead
  ) * PER_TOKEN;
}

/**
 * The rate for a model a server-side fallback named that has no row in PRICES: field by field the
 * highest known rate (requested model included), so an unlisted model is never billed below
 * what it may really cost. Budgets then still see the spend; see unpricedModels().
 */
function conservativePrice(base) {
  const rows = [base, ...Object.entries(PRICES).filter(([m]) => m !== 'scripted').map(([, p]) => p)];
  const out = {};
  for (const key of Object.keys(base)) out[key] = Math.max(...rows.map((p) => p[key]));
  return out;
}

/** Sampling iterations of a fallback response ({type:'message'|'fallback_message', model, ...tokens}). */
function fallbackIterations(usage) {
  const iterations = Array.isArray(usage?.iterations) ? usage.iterations : [];
  if (!iterations.some((it) => it?.type === 'fallback_message')) return null;
  return iterations.filter((it) => it?.type === 'message' || it?.type === 'fallback_message');
}

const iterationModel = (model, it) => (typeof it.model === 'string' && it.model ? it.model : model);

/**
 * USD cost of one provider response, split by the model that ran each part.
 *
 * When a server-side fallback served part of the response, `usage.iterations` breaks the tokens
 * down per model; each sampling iteration is priced at the rate of the model that ran it (an
 * iteration without a model is the requested model). A fallback model missing from PRICES is
 * priced at the highest known rate rather than failing: the response is already paid for, and an
 * unrecorded cost is worse than a conservative one. Web search is billed to the requested model.
 * @param {string} model the requested model
 * @param {object} usage Anthropic `usage` object
 * @returns {Record<string, number>} model -> USD (sums to costOf(model, usage))
 * @throws {Error} 'no price for model …' when the requested model is unknown
 */
export function costByModel(model, usage = {}) {
  const base = priceFor(model);
  const out = {};
  const add = (m, usd) => {
    out[m] = (out[m] || 0) + usd;
  };
  const iterations = fallbackIterations(usage);
  if (iterations) {
    for (const it of iterations) {
      const m = iterationModel(model, it);
      add(m, tokenCost(Object.hasOwn(PRICES, m) ? PRICES[m] : conservativePrice(base), it));
    }
  } else {
    add(model, tokenCost(base, usage));
  }
  const searches = usage.server_tool_use?.web_search_requests || 0;
  if (searches) add(model, (searches * WEB_SEARCH_USD_PER_1K) / 1000);
  if (!Object.hasOwn(out, model)) out[model] = 0;
  return out;
}

/**
 * USD cost of one provider response (see costByModel for fallback responses).
 * @param {string} model the requested model
 * @param {object} usage Anthropic `usage` object
 * @returns {number}
 * @throws {Error} 'no price for model …' when the requested model is unknown
 */
export function costOf(model, usage = {}) {
  return Object.values(costByModel(model, usage)).reduce((sum, usd) => sum + usd, 0);
}

/** Fallback models named in `usage.iterations` that PRICES does not list (billed conservatively). */
export function unpricedModels(usage = {}) {
  const iterations = fallbackIterations(usage) || [];
  return [...new Set(iterations.map((it) => it.model).filter((m) => typeof m === 'string' && m && !Object.hasOwn(PRICES, m)))];
}

/**
 * The model that answered a fallback response, when it is not the requested one: the last
 * fallback_message iteration's model, else the response's own `model` field. Null otherwise.
 */
export function servedModel(model, usage = {}, responseModel = null) {
  const iterations = fallbackIterations(usage);
  const last = iterations?.filter((it) => it.type === 'fallback_message' && typeof it.model === 'string' && it.model).at(-1);
  const served = last?.model ?? (iterations ? responseModel : null);
  return served && served !== model ? served : null;
}
