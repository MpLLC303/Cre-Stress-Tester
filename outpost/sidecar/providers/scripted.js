// Scripted provider: the offline stand-in for Claude. The decisions are scripted; everything the
// loop does with them (capability checks, tools, files, events, approvals) is real. Runs are
// announced with provider 'scripted' so the UI can label them.

const ZERO_USAGE = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

function defaultFallback({ agent }) {
  return {
    content: [{ type: 'text', text: `No scripted behaviour for ${agent.id}; connect a model (ANTHROPIC_API_KEY) to run this task.` }],
    stop_reason: 'end_turn',
  };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

/**
 * The tool results the loop sent back in the last user turn, with each call's tool name
 * recovered from the preceding assistant turn's tool_use blocks.
 * @returns {Array<{tool_use_id:string, name:string|null, content:string, is_error:boolean}>}
 */
export function lastToolResults(messages) {
  const last = messages.at(-1);
  if (last?.role !== 'user' || !Array.isArray(last.content)) return [];
  const prev = messages.at(-2);
  const names = new Map(
    (prev?.role === 'assistant' && Array.isArray(prev.content) ? prev.content : [])
      .filter((b) => b.type === 'tool_use')
      .map((b) => [b.id, b.name]),
  );
  return last.content
    .filter((b) => b.type === 'tool_result')
    .map((b) => ({
      tool_use_id: b.tool_use_id,
      name: names.get(b.tool_use_id) ?? null,
      content: resultText(b.content),
      is_error: b.is_error === true,
    }));
}

/**
 * @param {{scripts?: Record<string, Function>, fallback?: Function}} [opts]
 *   scripts[agentId]({agent, task, messages, turn, lastToolResults}) -> {content, stop_reason}
 *   (sync or async). `fallback` handles agents without a script.
 * @returns {{name:'scripted', model:'scripted', createMessage:(args:object) => Promise<object>}}
 */
export function createScriptedProvider({ scripts = {}, fallback = defaultFallback } = {}) {
  let messageCount = 0;
  let runCount = 0;
  // A run is identified by its first user message object: the loop's history is append-only,
  // so that object is the same reference on every turn of one run.
  const runNumbers = new WeakMap();

  return {
    name: 'scripted',
    model: 'scripted',
    async createMessage({ messages, signal, agent, task }) {
      signal?.throwIfAborted();
      const head = messages[0];
      if (!runNumbers.has(head)) runNumbers.set(head, ++runCount);
      const run = runNumbers.get(head);
      const turn = messages.filter((m) => m.role === 'assistant').length + 1;
      const script = Object.hasOwn(scripts, agent.id) ? scripts[agent.id] : fallback;
      const out = await script({ agent, task, messages, turn, lastToolResults: lastToolResults(messages) });
      let i = 0;
      const content = (out?.content || []).map((block) =>
        block.type === 'tool_use'
          ? { ...block, id: `toolu_scripted_${run}_${turn}_${i++}`, input: block.input ?? {} }
          : { ...block },
      );
      return {
        id: `msg_scripted_${++messageCount}`,
        type: 'message',
        role: 'assistant',
        model: 'scripted',
        content,
        stop_reason: out?.stop_reason ?? (i > 0 ? 'tool_use' : 'end_turn'),
        stop_sequence: null,
        usage: { ...ZERO_USAGE },
      };
    },
  };
}
