// The Anthropic provider against the real SDK stream helper: a local server speaks the Messages
// API's SSE wire format, so what is checked here is what the installed @anthropic-ai/sdk does with
// the provider's request (headers, body) and with a malformed streamed tool input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { DISPLAY_UPDATES_BETA, FALLBACK_BETA, createAnthropicProvider } from '../sidecar/providers/anthropic.js';

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** One streamed tool turn: a progress note, then a tool_use whose input arrives in `chunks`. */
function toolTurn(chunks) {
  return [
    sse('message_start', {
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 } },
    }),
    sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Saving the brief first.' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig_1' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: {} } }),
    ...chunks.map((partial_json) => sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json } })),
    sse('content_block_stop', { index: 1 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } }),
    sse('message_stop', {}),
  ].join('');
}

/** Serves `responses` in order (a string is an SSE body; {status, body} an error) and records requests. */
async function fakeApi(responses) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      const next = responses[Math.min(requests.length, responses.length) - 1];
      if (typeof next === 'string') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_${requests.length}` });
        res.end(next);
      } else {
        res.writeHead(next.status, { 'content-type': 'application/json', 'request-id': `req_${requests.length}` });
        res.end(JSON.stringify(next.body));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    requests,
    client: new Anthropic({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const tool = {
  name: 'write_file',
  description: 'Write a file',
  input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  strict: true,
};
const args = (extra = {}) => ({ model: 'claude-opus-5-5', effort: 'medium', system: 'You are PIXEL.', tools: [tool], messages: [{ role: 'user', content: 'Write the brief.' }], ...extra });

test('real SDK: the request is streamed with the betas header, eager strict tools and display updates; the final message is assembled', async () => {
  const api = await fakeApi([toolTurn(['{"text": "mu', 'g brief"}'])]);
  try {
    const provider = createAnthropicProvider({ client: api.client, eagerInputStreaming: true });
    const msg = await provider.createMessage(args());
    assert.equal(msg.stop_reason, 'tool_use');
    assert.deepEqual(msg.content.map((b) => b.type), ['thinking', 'tool_use']);
    assert.equal(msg.content[0].thinking, 'Saving the brief first.');
    assert.deepEqual(msg.content[1].input, { text: 'mug brief' });
    assert.equal(msg.usage.output_tokens, 42);

    assert.equal(api.requests.length, 1);
    const [{ url, headers, body }] = api.requests;
    assert.equal(url, '/v1/messages?beta=true');
    assert.equal(headers['anthropic-beta'], `${FALLBACK_BETA},${DISPLAY_UPDATES_BETA}`);
    assert.equal(body.stream, true);
    assert.equal(body.betas, undefined, 'betas travel as the header, not in the body');
    assert.equal(body.max_tokens, 64000);
    assert.equal(body.fallbacks, 'default');
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'updates' });
    assert.deepEqual(body.output_config, { effort: 'medium' });
    assert.deepEqual(body.cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.tools, [{ ...tool, eager_input_streaming: true }]);
  } finally {
    await api.close();
  }
});

test('real SDK: a tool input the SDK cannot parse re-issues the turn once and reports the billed attempt', async () => {
  const api = await fakeApi([toolTurn(['{]']), toolTurn(['{"text": "ok"}'])]);
  try {
    const discarded = [];
    const provider = createAnthropicProvider({ client: api.client, eagerInputStreaming: true });
    const msg = await provider.createMessage(args({ onDiscardedAttempt: (d) => discarded.push(d) }));
    assert.deepEqual(msg.content[1].input, { text: 'ok' });
    assert.equal(api.requests.length, 2);
    assert.deepEqual(api.requests[1].body, api.requests[0].body, 'the same turn is re-issued');
    assert.equal(discarded.length, 1);
    assert.ok(discarded[0].error instanceof Anthropic.AnthropicError);
    assert.ok(!(discarded[0].error instanceof Anthropic.APIError), 'the SDK raises its JSON error as a plain AnthropicError');
    assert.equal(discarded[0].usage.input_tokens, 1200);
    assert.equal(discarded[0].usage.cache_read_input_tokens, 800);
  } finally {
    await api.close();
  }
});

test('real SDK: a rate-limit error is never re-issued', async () => {
  const api = await fakeApi([{ status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } }]);
  try {
    const provider = createAnthropicProvider({ client: api.client, eagerInputStreaming: true });
    await assert.rejects(provider.createMessage(args()), (e) => e instanceof Anthropic.RateLimitError && e.status === 429);
    assert.equal(api.requests.length, 1);
  } finally {
    await api.close();
  }
});
