// Event catalog: the frozen contract between the runtime (sidecar) and the station UI.
//
// Every state change in Outpost is one of these events, appended to an NDJSON log.
// The UI never holds state the log cannot reproduce: it replays a snapshot and then
// applies the same events through shared/projector.js.
//
// Envelope: { seq, ts, type, actor, payload }
//   seq   - monotonically increasing integer assigned by the store
//   ts    - ISO-8601 timestamp assigned by the store
//   actor - 'system' | 'operator' | <agentId> | 'scheduler' | 'connector:<name>'
//
// Rules: additive only. Never rename or remove an event type or a required field.
//
// Web taint: content fetched from the web can carry injected instructions, so everything derived
// from it is marked. Payloads that carry `taint: 'web'` also carry `taintSources`, the direct
// reasons, each one of: 'web' (the run used web_search / web_fetch), an artifact id (a tainted
// input or read), a run id (a tainted child run under review) or 'memory:<namespace>/<key>'
// (a tainted room-memory note). Untainted payloads omit both fields.

/** @typedef {{seq:number, ts:string, type:string, actor:string, payload:object}} OutpostEvent */

export const WEB_TAINT = 'web';

// Field spec mini-language: 'string', 'number', 'boolean', 'object', 'array', 'any';
// suffix '?' marks optional; a pipe-separated list of quoted literals is an enum.
export const EVENT_TYPES = {
  'station.loaded': { station: 'object' },
  'estop': { engaged: 'boolean' },

  'agent.status': {
    agentId: 'string',
    status: "'idle'|'thinking'|'tool'|'awaiting_approval'|'handoff'|'error'|'paused'",
    runId: 'string?',
    taskId: 'string?',
    tool: 'string?',
    objectId: 'string?',
    detail: 'string?',
  },

  'task.created': {
    taskId: 'string',
    title: 'string',
    brief: 'string',
    assignee: 'string',
    createdBy: 'string',
    parentTaskId: 'string?',
    recipeRunId: 'string?',
    stage: 'number?',
    dependsOn: 'array?',
    inputs: 'array?', // artifactIds handed to this task
    kind: "'work'|'review'?",
  },
  'task.status': {
    taskId: 'string',
    status: "'queued'|'running'|'awaiting_approval'|'done'|'failed'|'cancelled'",
    reason: 'string?',
    outputs: 'array?', // artifactIds produced (on done)
    summary: 'string?',
  },

  'run.started': {
    runId: 'string',
    taskId: 'string',
    agentId: 'string',
    provider: 'string', // 'anthropic' | 'scripted'
    model: 'string',
    effort: 'string?',
    tools: 'array',
  },
  'run.step': {
    runId: 'string',
    agentId: 'string',
    turn: 'number',
    stopReason: 'string',
    usage: 'object', // raw usage numbers from the provider
    costUsd: 'number', // cost of this step, computed from sidecar/pricing.js
    text: 'string?', // visible assistant text this turn, truncated
    // Set when a server-side fallback served (part of) the turn: costUsd split per model that ran
    // (sums to costUsd), and the model that answered when it is not the requested one.
    costByModel: 'object?',
    servedModel: 'string?',
  },
  'run.finished': {
    runId: 'string',
    agentId: 'string',
    taskId: 'string',
    outcome: "'completed'|'failed'|'aborted'|'budget_exceeded'|'max_turns'|'refused'|'interrupted'",
    turns: 'number',
    costUsd: 'number',
    summary: 'string?',
    error: 'string?',
    servedModels: 'array?', // fallback models that answered turns of this run (absent when none)
    taint: "'web'?", // the run saw web content, directly or through a tainted input
    taintSources: 'array?',
  },

  'tool.called': {
    runId: 'string',
    callId: 'string',
    agentId: 'string',
    tool: 'string',
    objectId: 'string?', // station object that grants this tool (sprite walks there)
    input: 'string', // JSON preview, truncated
  },
  'tool.result': {
    runId: 'string',
    callId: 'string',
    agentId: 'string',
    tool: 'string',
    ok: 'boolean',
    output: 'string', // preview, truncated
    durationMs: 'number',
  },
  'tool.denied': {
    runId: 'string',
    callId: 'string',
    agentId: 'string',
    tool: 'string',
    reason: 'string',
  },

  'approval.requested': {
    approvalId: 'string',
    runId: 'string',
    agentId: 'string',
    taskId: 'string',
    tool: 'string',
    summary: 'string',
    input: 'string',
    taint: "'web'?", // requested by a web-tainted run: review the request for injected instructions
    taintSources: 'array?',
  },
  'approval.resolved': {
    approvalId: 'string',
    decision: "'granted'|'denied'|'expired'",
    note: 'string?',
  },

  'handoff': {
    handoffId: 'string',
    fromAgent: 'string',
    toAgent: 'string',
    fromRoom: 'string',
    toRoom: 'string',
    route: 'array', // ordered hallway ids the packet travels through ([] = same room)
    taskId: 'string', // the task created for the receiver
    artifactIds: 'array',
  },

  'artifact.created': {
    artifactId: 'string',
    agentId: 'string',
    taskId: 'string?',
    runId: 'string?',
    kind: "'text'|'json'|'svg'|'image'|'listing_draft'|'package'|'delivery'|'publish_receipt'",
    title: 'string',
    path: 'string', // relative to the data dir
    mime: 'string',
    bytes: 'number',
    sha256: 'string',
    taint: "'web'?", // written by a web-tainted run
    taintSources: 'array?',
  },

  'memory.written': { agentId: 'string', namespace: 'string', key: 'string', bytes: 'number', taint: "'web'?", taintSources: 'array?' },

  // Non-LLM spend the runtime computed (e.g. image generation), so budgets see it.
  'spend.recorded': {
    agentId: 'string',
    runId: 'string?',
    category: "'image'|'other'",
    model: 'string',
    usd: 'number',
    detail: 'string?',
  },

  'ledger.entry': {
    entryId: 'string',
    kind: "'revenue'|'refund'|'fee'|'cost'",
    amountCents: 'number', // integer, always positive; kind decides the sign
    currency: 'string',
    stream: 'string', // 'etsy' | 'fiverr' | 'assets' | free-form business line
    provenance: "'connector'|'manual'|'agent_claim'",
    source: 'object', // { connector?, externalId?, url?, note? }
    occurredAt: 'string',
    memo: 'string?',
  },

  'connector.sync': {
    connector: 'string',
    ok: 'boolean',
    fetched: 'number',
    newEntries: 'number',
    error: 'string?',
  },

  'recipe.started': { recipeRunId: 'string', recipe: 'string', title: 'string', taskIds: 'array' },
  'schedule.created': { scheduleId: 'string', spec: 'string', template: 'object', enabled: 'boolean' },
  'schedule.fired': { scheduleId: 'string', taskIds: 'array' },

  'log': { level: "'info'|'warn'|'error'", message: 'string' },
};

function checkField(spec, value) {
  const optional = spec.endsWith('?');
  const base = optional ? spec.slice(0, -1) : spec;
  if (value === undefined || value === null) return optional;
  if (base.startsWith("'")) {
    const allowed = base.split('|').map((s) => s.replace(/'/g, ''));
    return allowed.includes(value);
  }
  switch (base) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && !Array.isArray(value);
    case 'any': return true;
    default: return false;
  }
}

/**
 * Validate an event payload against the catalog.
 * @returns {string|null} error message, or null if valid
 */
export function validatePayload(type, payload) {
  const spec = EVENT_TYPES[type];
  if (!spec) return `unknown event type: ${type}`;
  if (typeof payload !== 'object' || payload === null) return `${type}: payload must be an object`;
  for (const [field, fieldSpec] of Object.entries(spec)) {
    if (!checkField(fieldSpec, payload[field])) {
      return `${type}: field "${field}" expected ${fieldSpec}, got ${JSON.stringify(payload[field])?.slice(0, 80)}`;
    }
  }
  if (spec.taintSources && Array.isArray(payload.taintSources) && !payload.taintSources.every((s) => typeof s === 'string')) {
    return `${type}: field "taintSources" must contain only strings`;
  }
  return null;
}

/** Truncate a string for event previews (keeps the log small and the UI legible). */
export function preview(value, max = 600) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return '';
  return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s;
}
