import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_MAX_TOKENS,
  DISPLAY_UPDATES_BETA,
  FALLBACK_BETA,
  MAX_JSON_RETRIES,
  MODEL_CAPS,
  UNKNOWN_MODEL_MAX_TOKENS,
  createAnthropicProvider,
} from '../sidecar/providers/anthropic.js';

const okMessage = () => ({ id: 'msg_1', type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn', usage: {} });

/**
 * A client whose beta.messages.stream() returns what the SDK's BetaMessageStream exposes to the
 * provider: finalMessage(), abort(), currentMessage. `respond(params, n)` gives the n-th call's
 * final message, or throws to make finalMessage() reject.
 */
function fakeClient(respond = okMessage, { baseURL, usage = { input_tokens: 1500, output_tokens: 1, cache_read_input_tokens: 900 } } = {}) {
  const calls = [];
  return {
    calls,
    baseURL,
    beta: {
      messages: {
        stream: (params, options) => {
          const call = { params, options, aborted: false };
          calls.push(call);
          const n = calls.length;
          return {
            currentMessage: { usage },
            abort() {
              call.aborted = true;
            },
            finalMessage: async () => respond(params, n),
          };
        },
        create: () => {
          throw new Error('the provider streams: beta.messages.create must not be called');
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
const quietLogger = () => {
  const warnings = [];
  return { warnings, warn: (m) => warnings.push(m) };
};
const jsonError = () => new Anthropic.AnthropicError('Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: SyntaxError. JSON: {]');

test('request shape on claude-opus-5-5: streamed, fallback + display-updates betas, adaptive thinking with updates, effort, caching, signal', async () => {
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
    signal: controller.signal,
    agent: { id: 'nova' },
    task: { taskId: 't1' },
  });

  assert.equal(provider.name, 'anthropic');
  assert.equal(client.calls.length, 1);
  const { params, options } = client.calls[0];
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.max_tokens, 64000);
  assert.equal(DEFAULT_MAX_TOKENS, 64000);
  assert.deepEqual(params.betas, [FALLBACK_BETA, DISPLAY_UPDATES_BETA]);
  assert.equal(FALLBACK_BETA, 'server-side-fallback-2026-07-01');
  assert.equal(DISPLAY_UPDATES_BETA, 'thinking-display-updates-2026-08-18');
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.thinking, { type: 'adaptive', display: 'updates' });
  assert.deepEqual(params.output_config, { effort: 'high' });
  assert.deepEqual(params.system, [{ type: 'text', text: 'You are NOVA.', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(params.cache_control, { type: 'ephemeral' });
  assert.equal(options.signal, controller.signal);
  assert.equal(params.messages, messages, 'history is passed through, not rebuilt');
  assert.deepEqual(messages, snapshot, 'history is never mutated');
  assert.equal(params.agent, undefined);
  assert.equal(params.task, undefined);
  assert.equal(params.stream, undefined, 'the SDK stream helper sets stream itself');
});

test('per-model request shapes follow MODEL_CAPS: nothing a model rejects is ever sent (LIVE-2)', async () => {
  const fullTools = [{ ...clientTool, eager_input_streaming: true }, serverTool];
  const expected = {
    'claude-opus-5-5': { thinking: { type: 'adaptive', display: 'updates' }, effort: true, fallbacks: 'default', betas: [FALLBACK_BETA, DISPLAY_UPDATES_BETA], max: 64000 },
    'claude-sonnet-5-5': { thinking: { type: 'adaptive', display: 'updates' }, effort: true, fallbacks: 'default', betas: [FALLBACK_BETA, DISPLAY_UPDATES_BETA], max: 64000 },
    'claude-fable-5-1': { thinking: { type: 'adaptive', display: 'updates' }, effort: true, fallbacks: 'default', betas: [FALLBACK_BETA, DISPLAY_UPDATES_BETA], max: 64000 },
    'claude-opus-5': { thinking: { type: 'adaptive' }, effort: true, fallbacks: 'default', betas: [FALLBACK_BETA], max: 64000 },
    'claude-opus-4-8': { thinking: { type: 'adaptive' }, effort: true, fallbacks: undefined, betas: undefined, max: 64000 },
    'claude-sonnet-5': { thinking: { type: 'adaptive' }, effort: true, fallbacks: undefined, betas: undefined, max: 64000 },
    'claude-haiku-4-5': { thinking: undefined, effort: false, fallbacks: undefined, betas: undefined, max: 64000 },
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(MODEL_CAPS).sort(), 'every row of the table is covered');
  for (const [model, want] of Object.entries(expected)) {
    const client = fakeClient();
    await createAnthropicProvider({ client, logger: quietLogger() }).createMessage({
      model,
      effort: 'medium',
      system: 's',
      tools: [clientTool, serverTool],
      messages: [{ role: 'user', content: 'go' }],
    });
    const { params } = client.calls[0];
    assert.deepEqual(params.thinking, want.thinking, `${model} thinking`);
    assert.deepEqual(params.output_config, want.effort ? { effort: 'medium' } : undefined, `${model} effort`);
    assert.equal(params.fallbacks, want.fallbacks, `${model} fallbacks`);
    assert.deepEqual(params.betas, want.betas, `${model} betas`);
    assert.equal(params.max_tokens, want.max, `${model} max_tokens`);
    assert.deepEqual(params.cache_control, { type: 'ephemeral' }, `${model} automatic caching`);
    assert.deepEqual(params.system[0].cache_control, { type: 'ephemeral' }, `${model} system breakpoint`);
    assert.deepEqual(params.tools, fullTools, `${model} tools: strict + eager client tools, server tools untouched`);
  }
});

test('claude-haiku-4-5 gets no thinking, effort, fallbacks or betas (the OUTPOST_MODEL example that used to 400)', async () => {
  const client = fakeClient();
  await createAnthropicProvider({ client }).createMessage({ model: 'claude-haiku-4-5', effort: 'low', system: 's', tools: [clientTool], messages: [{ role: 'user', content: 'hi' }] });
  const { params } = client.calls[0];
  for (const key of ['thinking', 'output_config', 'fallbacks', 'betas']) assert.equal(key in params, false, `${key} is omitted`);
  assert.equal(params.tools[0].strict, true);
});

test('an effort level the model does not list is omitted, not sent', async () => {
  const client = fakeClient();
  await createAnthropicProvider({ client }).createMessage({ model: 'claude-opus-5-5', effort: 'turbo', system: 's', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal('output_config' in client.calls[0].params, false);
});

test('an unknown model gets the conservative minimal request, and the provider logs it once per model', async () => {
  const client = fakeClient();
  const logger = quietLogger();
  const provider = createAnthropicProvider({ client, logger });
  const args = { model: 'claude-future-9', effort: 'high', system: 's', tools: [clientTool, serverTool], messages: [{ role: 'user', content: 'hi' }] };
  await provider.createMessage(args);
  await provider.createMessage(args);
  const { params } = client.calls[0];
  for (const key of ['thinking', 'output_config', 'fallbacks', 'betas']) assert.equal(key in params, false, `${key} is omitted`);
  assert.equal(params.max_tokens, UNKNOWN_MODEL_MAX_TOKENS);
  assert.deepEqual(params.tools, [clientTool, serverTool], 'strict as always, but no eager input streaming');
  assert.deepEqual(params.cache_control, { type: 'ephemeral' });
  assert.equal(logger.warnings.length, 1, 'logged once');
  assert.match(logger.warnings[0], /claude-future-9 is not in the Anthropic provider's feature table/);
  await provider.createMessage({ ...args, model: 'claude-future-10' });
  assert.equal(logger.warnings.length, 2, 'each unknown model is logged once');
});

test('max_tokens: 64000 by default, configurable, lowered by the caller and by the model\'s output limit', async () => {
  const send = async (opts, call) => {
    const client = fakeClient();
    await createAnthropicProvider({ client, ...opts }).createMessage({ system: 's', messages: [{ role: 'user', content: 'x' }], ...call });
    return client.calls[0].params.max_tokens;
  };
  assert.equal(await send({}, { model: 'claude-opus-5-5' }), 64000);
  assert.equal(await send({ maxTokens: 32000 }, { model: 'claude-opus-5-5' }), 32000);
  assert.equal(await send({}, { model: 'claude-opus-5-5', maxTokens: 20000 }), 20000, 'the loop may ask for less');
  assert.equal(await send({}, { model: 'claude-opus-5-5', maxTokens: 500000 }), 64000, 'never above the configured ceiling');
  assert.equal(await send({ maxTokens: 100000 }, { model: 'claude-opus-5-5' }), 100000);
  assert.equal(await send({ maxTokens: 100000 }, { model: 'claude-haiku-4-5' }), 64000, "never above the model's output limit");
});

test('client tools go out strict with eager input streaming, caller objects untouched; server tools pass through', async () => {
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
  assert.deepEqual(wireLoose, { ...clientTool, strict: true, eager_input_streaming: true });
  assert.deepEqual(wireStrict, { ...clientTool, eager_input_streaming: true });
  assert.equal(loose.strict, undefined, 'caller tool untouched');
  assert.equal('eager_input_streaming' in clientTool, false, 'caller tool untouched');
  assert.equal(wireServer, serverTool);
  assert.equal(wireServer.strict, undefined);
  assert.equal(wireServer.eager_input_streaming, undefined, 'not a valid field on server tools');
});

test('eager input streaming is off behind a custom base URL unless asked for', async () => {
  const toolsSent = async (clientOpts, providerOpts = {}) => {
    const client = fakeClient(okMessage, clientOpts);
    await createAnthropicProvider({ client, ...providerOpts }).createMessage({ model: 'claude-opus-5-5', system: 's', tools: [clientTool], messages: [{ role: 'user', content: 'x' }] });
    return client.calls[0].params.tools[0];
  };
  assert.equal((await toolsSent({ baseURL: 'https://api.anthropic.com' })).eager_input_streaming, true);
  assert.equal((await toolsSent({ baseURL: 'https://llm-gateway.example.com/anthropic' })).eager_input_streaming, undefined);
  assert.equal((await toolsSent({ baseURL: 'https://llm-gateway.example.com/anthropic' }, { eagerInputStreaming: true })).eager_input_streaming, true);
  assert.equal((await toolsSent({}, { eagerInputStreaming: false })).eager_input_streaming, undefined);
});

test('no tools and no effort: those fields are omitted', async () => {
  const client = fakeClient();
  await createAnthropicProvider({ client }).createMessage({ model: 'claude-opus-5-5', system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }] });
  const { params } = client.calls[0];
  assert.equal('tools' in params, false);
  assert.equal('output_config' in params, false);
});

test('the SDK final message is returned unchanged', async () => {
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

test('typed SDK errors propagate to the caller and are never re-issued', async () => {
  const err = new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, undefined, new Headers());
  const client = fakeClient(() => {
    throw err;
  });
  const discarded = [];
  await assert.rejects(
    createAnthropicProvider({ client }).createMessage({ model: 'claude-opus-5-5', effort: 'low', system: 's', messages: [{ role: 'user', content: 'x' }], onDiscardedAttempt: (d) => discarded.push(d) }),
    (e) => e === err && e instanceof Anthropic.RateLimitError && e.status === 429,
  );
  assert.equal(client.calls.length, 1);
  assert.equal(discarded.length, 0);
});

test('an unparseable streamed tool input re-issues the turn; the discarded attempt is aborted and reported (LIVE-5)', async () => {
  const message = { ...okMessage(), id: 'msg_ok' };
  const client = fakeClient((params, n) => {
    if (n === 1) throw jsonError();
    return message;
  });
  const discarded = [];
  const messages = [{ role: 'user', content: 'x' }];
  const out = await createAnthropicProvider({ client }).createMessage({ model: 'claude-opus-5-5', system: 's', tools: [clientTool], messages, onDiscardedAttempt: (d) => discarded.push(d) });
  assert.equal(out, message);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].aborted, true, 'the discarded stream is aborted');
  assert.equal(client.calls[1].aborted, false);
  assert.equal(client.calls[1].params, client.calls[0].params, 'the same request is re-issued');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].attempt, 1);
  assert.deepEqual(discarded[0].usage, { input_tokens: 1500, output_tokens: 1, cache_read_input_tokens: 900 });
  assert.ok(discarded[0].error instanceof Anthropic.AnthropicError);
});

test('re-issues stop after MAX_JSON_RETRIES (2): the third failure propagates', async () => {
  const err = jsonError();
  const client = fakeClient(() => {
    throw err;
  });
  const discarded = [];
  await assert.rejects(
    createAnthropicProvider({ client }).createMessage({ model: 'claude-opus-5-5', system: 's', messages: [{ role: 'user', content: 'x' }], onDiscardedAttempt: (d) => discarded.push(d) }),
    (e) => e === err,
  );
  assert.equal(MAX_JSON_RETRIES, 2);
  assert.equal(client.calls.length, 3);
  assert.deepEqual(discarded.map((d) => d.attempt), [1, 2]);
});

test('aborts, connection errors and wrapped foreign errors are never re-issued; nor is anything after the run is halted', async () => {
  const cases = [
    () => new Anthropic.APIUserAbortError(),
    () => new Anthropic.APIConnectionError({ message: 'socket hang up' }),
    () => Object.assign(new Anthropic.AnthropicError('fetch failed'), { cause: new TypeError('fetch failed') }),
    () => new TypeError('not an SDK error'),
  ];
  for (const make of cases) {
    const err = make();
    const client = fakeClient(() => {
      throw err;
    });
    await assert.rejects(createAnthropicProvider({ client }).createMessage({ model: 'claude-opus-5-5', system: 's', messages: [{ role: 'user', content: 'x' }] }), (e) => e === err);
    assert.equal(client.calls.length, 1, `${err.constructor.name} is not re-issued`);
  }
  const controller = new AbortController();
  const client = fakeClient(() => {
    controller.abort();
    throw jsonError();
  });
  await assert.rejects(createAnthropicProvider({ client }).createMessage({ model: 'claude-opus-5-5', system: 's', messages: [{ role: 'user', content: 'x' }], signal: controller.signal }));
  assert.equal(client.calls.length, 1, 'a halted run is not re-issued');
});
