import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICES, WEB_SEARCH_USD_PER_1K, costByModel, costOf, priceFor, servedModel, unpricedModels } from '../sidecar/pricing.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('contract prices are present (USD per million tokens)', () => {
  assert.deepEqual(PRICES['claude-opus-5-5'], { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 });
  assert.deepEqual(PRICES['claude-sonnet-5-5'], { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 });
  assert.deepEqual(PRICES['claude-haiku-4-5'], { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 });
  assert.equal(WEB_SEARCH_USD_PER_1K, 10);
});

test('costOf prices input, output, cache writes and cache reads', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 200_000, cache_read_input_tokens: 500_000 };
  // 4 + 2 + 0.2*5 + 0.5*0.2
  close(costOf('claude-opus-5-5', usage), 4 + 2 + 1 + 0.1);
});

test('cache writes use the 1h rate for the 1h share when the breakdown is present', () => {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 300_000,
    cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 200_000 },
  };
  close(costOf('claude-opus-5-5', usage), 0.1 * 5 + 0.2 * 8);
});

test('web search requests are billed per request', () => {
  close(costOf('claude-sonnet-5-5', { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } }), 0.03);
});

test('missing or null usage fields count as zero', () => {
  assert.equal(costOf('claude-haiku-4-5', {}), 0);
  assert.equal(costOf('claude-haiku-4-5', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, cache_creation: null, server_tool_use: null }), 0);
});

test('scripted runs cost nothing', () => {
  assert.equal(costOf('scripted', { input_tokens: 5000, output_tokens: 5000, cache_creation_input_tokens: 10, cache_read_input_tokens: 10 }), 0);
});

test('unknown models throw so a run never executes unpriced', () => {
  assert.throws(() => costOf('claude-imaginary-9', { input_tokens: 1 }), /no price for model claude-imaginary-9/);
  assert.throws(() => priceFor('constructor'), /no price for model/);
});

test('a server-side fallback is priced per iteration at each model\'s rate', () => {
  const usage = {
    input_tokens: 2_000_000,
    output_tokens: 100_000,
    iterations: [
      { type: 'message', model: null, input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ],
  };
  // declined attempt at opus-5-5 input rate (4) + fallback at opus-5 rates (5 + 0.1*25)
  close(costOf('claude-opus-5-5', usage), 4 + 5 + 2.5);
});

test('an unlisted fallback model is billed at the highest known rate, never skipped (RT-5)', () => {
  const usage = {
    iterations: [
      { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 0 },
      { type: 'fallback_message', model: 'claude-opus-5-6', input_tokens: 100_000, output_tokens: 19_900 },
    ],
  };
  // highest known rates: input 5, output 25 (opus-5 / opus-4-8)
  close(costOf('claude-opus-5-5', usage), 1000 * 4e-6 + 100_000 * 5e-6 + 19_900 * 25e-6);
  assert.deepEqual(unpricedModels(usage), ['claude-opus-5-6']);
  assert.deepEqual(unpricedModels({ input_tokens: 1 }), []);
  assert.throws(() => costOf('claude-unknown', { input_tokens: 1 }), /no price for model claude-unknown/, 'the requested model must still be priced');
});

test('costByModel splits a fallback response per model that ran it (TL-9)', () => {
  const usage = {
    iterations: [
      { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 0 },
      { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1000, output_tokens: 1000 },
    ],
    server_tool_use: { web_search_requests: 1 },
  };
  const split = costByModel('claude-opus-5-5', usage);
  close(split['claude-opus-5-5'], 0.004 + 0.01); // declined attempt + the web search, billed to the requested model
  close(split['claude-opus-4-8'], 0.005 + 0.025);
  close(Object.values(split).reduce((a, b) => a + b, 0), costOf('claude-opus-5-5', usage));
  assert.equal(servedModel('claude-opus-5-5', usage), 'claude-opus-4-8');
  assert.equal(servedModel('claude-opus-5-5', { input_tokens: 1 }, 'claude-opus-5-5'), null, 'no fallback, no served model');
  assert.deepEqual(costByModel('claude-haiku-4-5', { input_tokens: 1_000_000 }), { 'claude-haiku-4-5': 1 });
});
