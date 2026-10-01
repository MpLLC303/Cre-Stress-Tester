// Claude provider: one Messages API call per agent-loop step, via the official SDK.

import Anthropic from '@anthropic-ai/sdk';

/** Beta flag for the scalar `fallbacks: 'default'` form (the array form uses a different flag). */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const DEFAULT_MAX_TOKENS = 16000;

/**
 * Client tools always go out with `strict: true`, so tool inputs match their schema.
 * tools/index.js toolDefinitions() already shapes the schemas for strict mode; this only
 * guarantees the flag. Server tools (they carry a versioned `type`) pass through untouched.
 */
function wireTool(tool) {
  const isClient = tool.input_schema && (!tool.type || tool.type === 'custom');
  return isClient && tool.strict !== true ? { ...tool, strict: true } : tool;
}

/**
 * @param {{client?: object}} [opts] client defaults to `new Anthropic()`, which resolves
 *   credentials itself (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
 * @returns {{name:'anthropic', createMessage:(args:{model:string, effort?:string, system:string,
 *   tools:object[], messages:object[], maxTokens?:number, signal?:AbortSignal}) => Promise<object>}}
 */
export function createAnthropicProvider({ client = new Anthropic() } = {}) {
  return {
    name: 'anthropic',
    /**
     * One request; resolves with the SDK message object unchanged. SDK typed errors
     * (Anthropic.RateLimitError, ...) propagate to the loop, which records them.
     */
    async createMessage({ model, effort, system, tools = [], messages, maxTokens = DEFAULT_MAX_TOKENS, signal }) {
      const params = {
        model,
        max_tokens: maxTokens,
        // Caching, per the prompt-caching guide's agent-loop pattern: an explicit breakpoint on the
        // static system block (it caches tools + system, the prefix every turn of every run of this
        // agent shares) plus top-level automatic caching, which places a second breakpoint on the
        // last cacheable block and moves it forward as the append-only history grows. The two
        // compose (2 of the 4 breakpoint slots, both the default 5-minute TTL), and unlike a manual
        // marker on the last user block this never writes into the caller's message objects.
        cache_control: { type: 'ephemeral' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages,
        thinking: { type: 'adaptive' },
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      };
      if (tools.length) params.tools = tools.map(wireTool);
      if (effort) params.output_config = { effort };
      return client.beta.messages.create(params, { signal });
    },
  };
}
