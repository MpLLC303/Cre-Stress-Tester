// Claude provider: one streamed Messages API call per agent-loop step, via the official SDK.

import Anthropic from '@anthropic-ai/sdk';

/** Beta flag for the scalar `fallbacks: 'default'` form (the array form uses a different flag). */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Beta flag for `thinking.display: 'updates'` (between-tool progress notes come back as text). */
export const DISPLAY_UPDATES_BETA = 'thinking-display-updates-2026-08-18';
/**
 * Default ceiling on max_tokens. Thinking counts toward max_tokens, and the claude-api guidance for
 * long agentic turns on always-thinking models is 64K; above ~21K the SDK requires streaming.
 */
export const DEFAULT_MAX_TOKENS = 64000;
/** max_tokens for a model MODEL_CAPS does not list: the value the runtime used before streaming. */
export const UNKNOWN_MODEL_MAX_TOKENS = 16000;
/** Re-issues of one turn whose streamed tool input the SDK could not parse as JSON. */
export const MAX_JSON_RETRIES = 2;

const ALL_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const NO_EFFORTS = Object.freeze([]);

/**
 * What each model accepts, per the claude-api skill (shared/model-migration.md, models.md,
 * platform-availability.md). A request carries only what its model supports, so no model is sent
 * a parameter it rejects with a 400. Add a row only after checking the docs for that model.
 *   adaptive         thinking {type:'adaptive'} (models without it get no `thinking` at all)
 *   efforts          output_config.effort levels it accepts (empty: the parameter is omitted)
 *   defaultFallback  server-side refusal fallback `fallbacks: 'default'` (beta FALLBACK_BETA)
 *   displayUpdates   thinking.display 'updates' (beta DISPLAY_UPDATES_BETA): the between-tool notes
 *                    these models write as thinking blocks come back as text instead of empty
 *   maxOutput        the model's output-token limit (max_tokens is capped to it)
 */
export const MODEL_CAPS = Object.freeze({
  'claude-opus-5-5': Object.freeze({ adaptive: true, efforts: ALL_EFFORTS, defaultFallback: true, displayUpdates: true, maxOutput: 128000 }),
  'claude-sonnet-5-5': Object.freeze({ adaptive: true, efforts: ALL_EFFORTS, defaultFallback: true, displayUpdates: true, maxOutput: 128000 }),
  'claude-fable-5-1': Object.freeze({ adaptive: true, efforts: ALL_EFFORTS, defaultFallback: true, displayUpdates: true, maxOutput: 128000 }),
  'claude-opus-5': Object.freeze({ adaptive: true, efforts: ALL_EFFORTS, defaultFallback: true, displayUpdates: false, maxOutput: 128000 }),
  'claude-opus-4-8': Object.freeze({ adaptive: true, efforts: ALL_EFFORTS, defaultFallback: false, displayUpdates: false, maxOutput: 128000 }),
  'claude-sonnet-5': Object.freeze({ adaptive: true, efforts: ALL_EFFORTS, defaultFallback: false, displayUpdates: false, maxOutput: 128000 }),
  'claude-haiku-4-5': Object.freeze({ adaptive: false, efforts: NO_EFFORTS, defaultFallback: false, displayUpdates: false, maxOutput: 64000 }),
});

/**
 * Client tools always go out with `strict: true`, so tool inputs match their schema, and, on a
 * streamed request, with `eager_input_streaming: true` so a large input (an SVG, a file body)
 * streams as it is generated instead of arriving in one burst at the end. Eager input is not
 * validated by the API; the loop validates every input against its schema before running it and
 * never runs the tools of a max_tokens or refusal turn. tools/index.js toolDefinitions() already
 * shapes the schemas for strict mode. Server tools (they carry a versioned `type`) pass through
 * untouched: neither field is valid on them.
 */
function wireTool(tool, eager) {
  const isClient = tool.input_schema && (!tool.type || tool.type === 'custom');
  if (!isClient) return tool;
  const extra = {};
  if (tool.strict !== true) extra.strict = true;
  if (eager && tool.eager_input_streaming !== true) extra.eager_input_streaming = true;
  return Object.keys(extra).length ? { ...tool, ...extra } : tool;
}

/**
 * The SDK's error for streamed tool input it cannot parse as JSON. The TypeScript SDK raises it
 * as a plain AnthropicError (no subclass, no `cause`); the typed API errors, including aborts
 * (APIUserAbortError) and connection failures, are APIError subclasses, and other failures the
 * stream wraps carry their original error as `cause`. Only this error is worth re-issuing.
 */
function isToolInputJsonError(err) {
  return err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && err.cause === undefined;
}

/**
 * eager_input_streaming is valid on the Claude API for every current model, but a proxy or
 * gateway in front of it may reject the field, so it is on by default only for the first-party
 * endpoint (claude-api skill, tool-use-concepts.md -> Eager input streaming).
 */
function isFirstPartyApi(client) {
  const url = client?.baseURL;
  return !url || /^https:\/\/api\.anthropic\.com\/?$/.test(String(url));
}

/**
 * @param {object} [opts]
 * @param {object} [opts.client] defaults to `new Anthropic()`, which resolves credentials itself
 *   (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
 * @param {number} [opts.maxTokens] max_tokens ceiling for every request (default 64000); a caller's
 *   per-call `maxTokens` and the model's output limit can only lower it.
 * @param {boolean} [opts.eagerInputStreaming] default: on for the first-party API endpoint only.
 * @param {{warn:Function}} [opts.logger] receives the one-time warning for a model MODEL_CAPS lacks.
 * @returns {{name:'anthropic', createMessage:(args:{model:string, effort?:string, system:string,
 *   tools:object[], messages:object[], maxTokens?:number, signal?:AbortSignal,
 *   onDiscardedAttempt?:(info:{attempt:number, usage:object|null, error:Error}) => void}) => Promise<object>}}
 */
export function createAnthropicProvider({ client = new Anthropic(), maxTokens: ceiling = DEFAULT_MAX_TOKENS, eagerInputStreaming, logger = console } = {}) {
  const eager = eagerInputStreaming ?? isFirstPartyApi(client);
  const warned = new Set();

  function capsFor(model) {
    if (Object.hasOwn(MODEL_CAPS, model)) return MODEL_CAPS[model];
    if (!warned.has(model)) {
      warned.add(model);
      logger?.warn?.(`outpost: model ${model} is not in the Anthropic provider's feature table (MODEL_CAPS in sidecar/providers/anthropic.js); sending the minimal request: no thinking, effort, fallbacks, betas or eager tool input, max_tokens ${Math.min(ceiling, UNKNOWN_MODEL_MAX_TOKENS)}`);
    }
    return null;
  }

  function requestParams({ model, effort, system, tools, messages, maxTokens }) {
    const caps = capsFor(model);
    const limit = Math.min(ceiling, caps ? caps.maxOutput : UNKNOWN_MODEL_MAX_TOKENS);
    const betas = [];
    const params = {
      model,
      max_tokens: Number.isInteger(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, limit) : limit,
      // Caching, per the prompt-caching guide's agent-loop pattern: an explicit breakpoint on the
      // static system block (it caches tools + system, the prefix every turn of every run of this
      // agent shares) plus top-level automatic caching, which places a second breakpoint on the
      // last cacheable block and moves it forward as the append-only history grows. The two
      // compose (2 of the 4 breakpoint slots, both the default 5-minute TTL), and unlike a manual
      // marker on the last user block this never writes into the caller's message objects.
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    };
    // Fixed per model, so identical on every request of a run: changing `thinking` mid-run would
    // invalidate the messages cache.
    if (caps?.adaptive) {
      params.thinking = caps.displayUpdates ? { type: 'adaptive', display: 'updates' } : { type: 'adaptive' };
    }
    if (effort && caps?.efforts.includes(effort)) params.output_config = { effort };
    if (caps?.defaultFallback) {
      params.fallbacks = 'default';
      betas.push(FALLBACK_BETA);
    }
    if (caps?.adaptive && caps.displayUpdates) betas.push(DISPLAY_UPDATES_BETA);
    if (betas.length) params.betas = betas;
    if (tools.length) params.tools = tools.map((t) => wireTool(t, eager && caps !== null));
    return params;
  }

  return {
    name: 'anthropic',
    /**
     * One streamed request; resolves with the SDK's final message unchanged. When the SDK cannot
     * parse a tool input it streamed (eager input streaming), the turn is re-issued, at most
     * MAX_JSON_RETRIES times: that tool_use block never completed, so there is no id to answer.
     * The discarded attempt is aborted and reported to `onDiscardedAttempt` with the usage the
     * stream had reported, since it is billed. SDK typed errors (Anthropic.RateLimitError, ...)
     * and aborts are never re-issued; they propagate to the loop, which records them.
     */
    async createMessage({ model, effort, system, tools = [], messages, maxTokens, signal, onDiscardedAttempt }) {
      const params = requestParams({ model, effort, system, tools, messages, maxTokens });
      for (let attempt = 0; ; attempt += 1) {
        const stream = client.beta.messages.stream(params, { signal });
        try {
          return await stream.finalMessage();
        } catch (err) {
          if (!isToolInputJsonError(err) || attempt >= MAX_JSON_RETRIES || signal?.aborted) throw err;
          const usage = stream.currentMessage?.usage;
          stream.abort?.(); // stop generating (and billing) the discarded attempt
          onDiscardedAttempt?.({ attempt: attempt + 1, usage: usage ? { ...usage } : null, error: err });
        }
      }
    },
  };
}
