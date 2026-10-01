import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MAX_TOKENS, FALLBACK_BETA, createAnthropicProvider } from '../sidecar/providers/anthropic.js';

function fakeClient(respond = () => ({ id: 'msg_1', type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn', usage: {} })) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params, options) => {
          calls.push({ params, options });
          return respond(params);
        },
      },
    },
  };
}

const clientTool = {
  name: 'create_listing_draft',
  description: 'Draft a listing',
  input_schema: {
    type: 'object',
    properties: { title: { type: 'string', description: 'At most 140 characters.' }, tags: { type: 'array', items: { type: 'string' } } },
    required: ['title', 'tags'],
    additionalProperties: false,
  },
  strict: true,
};
const serverTool = { type: 'web_search_20260209', name: 'web_search', max_uses: 5 };

test('request shape: model, beta fallback, adaptive thinking, effort, caching, signal', async () => {
  const client = fakeClient();
  const provider = createAnthropicProvider({ client });
  const messages = [{ role: 'user', content: 'Find three niches.' }];
  const snapshot = structuredClone(messages);
  const controller = new AbortController();

  await provider.createMessage({
    model: 'claude-opus-5-5',
    effort: 'high',
    system: 'You are NOVA.',
    tools: [clientTool, serverTool],
    messages,
    maxTokens: DEFAULT_MAX_TOKENS,
    signal: controller.signal,
    agent: { id: 'nova' },
    task: { taskId: 't1' },
  });

  assert.equal(provider.name, 'anthropic');
  assert.equal(client.calls.length, 1);
  const { params, options } = client.calls[0];
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.max_tokens, 16000);
  assert.deepEqual(params.betas, [FALLBACK_BETA]);
  assert.equal(FALLBACK_BETA, 'server-side-fallback-2026-07-01');
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.thinking, { type: 'adaptive' });
  assert.deepEqual(params.output_config, { effort: 'high' });
  assert.deepEqual(params.system, [{ type: 'text', text: 'You are NOVA.', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(params.cache_control, { type: 'ephemeral' });
  assert.equal(options.signal, controller.signal);
  assert.equal(params.messages, messages, 'history is passed through, not rebuilt');
  assert.deepEqual(messages, snapshot, 'history is never mutated');
  assert.equal(params.agent, undefined);
  assert.equal(params.task, undefined);
});

test('client tools always go out strict and unmodified otherwise; server tools pass through', async () => {
  const client = fakeClient();
  const loose = { ...clientTool, strict: undefined };
  await createAnthropicProvider({ client }).createMessage({
    model: 'claude-opus-5-5',
    effort: 'medium',
    system: 's',
    tools: [loose, clientTool, serverTool],
    messages: [{ role: 'user', content: 'go' }],
  });
  const [wireLoose, wireStrict, wireServer] = client.calls[0].params.tools;
  assert.deepEqual(wireLoose, { ...clientTool, strict: true });
  assert.equal(loose.strict, undefined, 'caller tool untouched');
  assert.equal(wireStrict, clientTool);
  assert.equal(wireServer, serverTool);
  assert.equal(wireServer.strict, undefined);
  assert.equal(client.calls[0].params.max_tokens, DEFAULT_MAX_TOKENS);
});

test('no tools and no effort: those fields are omitted', async () => {
  const client = fakeClient();
  await createAnthropicProvider({ client }).createMessage({ model: 'claude-haiku-4-5', system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }] });
  const { params } = client.calls[0];
  assert.equal('tools' in params, false);
  assert.equal('output_config' in params, false);
});

test('the SDK message is returned unchanged', async () => {
  const message = {
    id: 'msg_x',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Done.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const provider = createAnthropicProvider({ client: fakeClient(() => message) });
  const out = await provider.createMessage({ model: 'claude-opus-5-5', effort: 'low', system: 's', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(out, message);
});

test('typed SDK errors propagate to the caller', async () => {
  const err = new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, undefined, new Headers());
  const provider = createAnthropicProvider({
    client: fakeClient(() => {
      throw err;
    }),
  });
  await assert.rejects(
    provider.createMessage({ model: 'claude-opus-5-5', effort: 'low', system: 's', messages: [{ role: 'user', content: 'x' }] }),
    (e) => e === err && e instanceof Anthropic.RateLimitError && e.status === 429,
  );
});
