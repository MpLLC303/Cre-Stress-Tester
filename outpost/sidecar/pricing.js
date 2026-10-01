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
// claude-sonnet-5 is the fallback target for claude-sonnet-5-5.

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
 * USD cost of one provider response.
 *
 * When a server-side fallback served part of the response, `usage.iterations` breaks the tokens
 * down per model; each sampling iteration is then priced at the rate of the model that ran it.
 * @param {string} model the requested model
 * @param {object} usage Anthropic `usage` object
 * @returns {number}
 * @throws {Error} 'no price for model …' for an unknown model (requested or fallback)
 */
export function costOf(model, usage = {}) {
  const base = priceFor(model);
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  const tokens = iterations.some((it) => it?.type === 'fallback_message')
    ? iterations
        .filter((it) => it.type === 'message' || it.type === 'fallback_message')
        .reduce((sum, it) => sum + tokenCost(it.model ? priceFor(it.model) : base, it), 0)
    : tokenCost(base, usage);
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return tokens + (searches * WEB_SEARCH_USD_PER_1K) / 1000;
}
