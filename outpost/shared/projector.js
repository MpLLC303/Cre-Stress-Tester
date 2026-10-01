// Projector: a pure reducer from the event log to station state.
//
// The sidecar and the browser import this same module. The server builds its state by
// folding the log; the UI folds a snapshot plus live events. Because both sides run
// the same code over the same events, anything on screen can be traced to the event
// sequence numbers that produced it.
//
// Pure means pure: no clocks, no randomness, no I/O. Timestamps come from events.

export const FEED_LIMIT = 150;
export const HANDOFF_LIMIT = 40;

export function initialState() {
  return {
    seq: 0,
    station: null,
    estop: false,
    agents: {},
    tasks: {},
    taskOrder: [],
    runs: {},
    artifacts: {},
    artifactOrder: [],
    approvals: {},
    handoffs: [],
    ledger: {
      entries: {},
      entryOrder: [],
      externalIds: {}, // `${connector}:${externalId}` -> entryId (dedup guard)
      totals: emptyTotals(),
      byStream: {},
    },
    spend: { totalUsd: 0, byAgent: {}, byModel: {}, byDay: {}, steps: 0 }, // byDay keyed by UTC date of the event ts
    connectors: {},
    recipes: {},
    schedules: {},
    memory: {}, // namespace -> { keys: {key: bytes}, writes }
    feed: [],
  };
}

function emptyTotals() {
  return {
    verifiedRevenueCents: 0, // provenance=connector: fetched from the platform API
    operatorRevenueCents: 0, // provenance=manual: typed in by the operator
    claimedRevenueCents: 0, // provenance=agent_claim: never counted in any total below
    feesCents: 0,
    costCents: 0,
    verifiedOrders: 0,
    operatorOrders: 0,
  };
}

/** Share of counted revenue that is backed by a connector (0..1), or null if none counted. */
export function evidenceCoverage(totals) {
  const counted = totals.verifiedRevenueCents + totals.operatorRevenueCents;
  if (counted <= 0) return null;
  return totals.verifiedRevenueCents / counted;
}

/** Net = counted revenue - fees - costs (agent claims excluded). LLM spend is reported separately. */
export function netCents(totals) {
  return totals.verifiedRevenueCents + totals.operatorRevenueCents - totals.feesCents - totals.costCents;
}

function agentDefaults(cfg) {
  return {
    ...cfg,
    status: 'idle',
    runId: null,
    taskId: null,
    tool: null,
    objectId: null,
    detail: '',
    spentUsd: 0,
    runs: 0,
    lastSeq: 0,
  };
}

function applyLedger(ledger, p) {
  const sign = p.kind === 'refund' ? -1 : 1;
  const stream = (ledger.byStream[p.stream] ||= emptyTotals());
  for (const t of [ledger.totals, stream]) {
    if (p.provenance === 'agent_claim') {
      if (p.kind === 'revenue' || p.kind === 'refund') t.claimedRevenueCents += sign * p.amountCents;
      continue; // claims never move counted totals
    }
    if (p.kind === 'revenue' || p.kind === 'refund') {
      if (p.provenance === 'connector') {
        t.verifiedRevenueCents += sign * p.amountCents;
        if (p.kind === 'revenue') t.verifiedOrders += 1;
      } else {
        t.operatorRevenueCents += sign * p.amountCents;
        if (p.kind === 'revenue') t.operatorOrders += 1;
      }
    } else if (p.kind === 'fee') {
      t.feesCents += p.amountCents;
    } else if (p.kind === 'cost') {
      t.costCents += p.amountCents;
    }
  }
}

function addDay(state, ts, usd) {
  const day = String(ts).slice(0, 10);
  state.spend.byDay[day] = (state.spend.byDay[day] || 0) + usd;
}

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

/** One-line human description of an event, used by the feed. Deterministic. */
export function describe(e) {
  const p = e.payload || {};
  switch (e.type) {
    case 'station.loaded': return `Station layout loaded (${p.station?.rooms?.length ?? 0} rooms, ${p.station?.agents?.length ?? 0} agents)`;
    case 'estop': return p.engaged ? 'E-STOP engaged: all runs halted' : 'E-STOP released';
    case 'agent.status': return `${p.agentId} → ${p.status}${p.tool ? ` (${p.tool})` : ''}${p.detail ? `: ${p.detail}` : ''}`;
    case 'task.created': return `Task ${p.taskId} "${p.title}" → ${p.assignee}`;
    case 'task.status': return `Task ${p.taskId} ${p.status}${p.reason ? `: ${p.reason}` : ''}`;
    case 'run.started': return `${p.agentId} started run ${p.runId} on ${p.model} [${p.provider}]`;
    case 'run.step': return `${p.agentId} turn ${p.turn} (${p.stopReason}) $${p.costUsd.toFixed(4)}`;
    case 'run.finished': return `${p.agentId} run ${p.runId} ${p.outcome} after ${p.turns} turns, $${p.costUsd.toFixed(4)}`;
    case 'tool.called': return `${p.agentId} → ${p.tool}`;
    case 'tool.result': return `${p.agentId} ← ${p.tool} ${p.ok ? 'ok' : 'error'} (${p.durationMs}ms)`;
    case 'tool.denied': return `${p.agentId} ✗ ${p.tool}: ${p.reason}`;
    case 'approval.requested': return `${p.agentId} requests approval: ${p.summary}`;
    case 'approval.resolved': return `Approval ${p.approvalId} ${p.decision}`;
    case 'handoff': return `${p.fromAgent} handed task ${p.taskId} to ${p.toAgent} (${p.fromRoom} → ${p.toRoom})`;
    case 'artifact.created': return `${p.agentId} produced ${p.kind} "${p.title}"`;
    case 'memory.written': return `${p.agentId} wrote memory ${p.namespace}/${p.key}`;
    case 'spend.recorded': return `${p.agentId} spent $${p.usd.toFixed(4)} on ${p.category} (${p.model})`;
    case 'ledger.entry': return `Ledger ${p.kind} ${money(p.amountCents)} ${p.stream} [${p.provenance}]`;
    case 'connector.sync': return p.ok ? `${p.connector} sync: ${p.newEntries} new of ${p.fetched}` : `${p.connector} sync failed: ${p.error}`;
    case 'recipe.started': return `Recipe ${p.recipe} started: "${p.title}"`;
    case 'schedule.created': return `Schedule ${p.scheduleId} (${p.spec})`;
    case 'schedule.fired': return `Schedule ${p.scheduleId} fired (${p.taskIds.length} tasks)`;
    case 'log': return p.message;
    default: return e.type;
  }
}

/**
 * Apply one event. Mutates and returns `state` (callers own their copy).
 * @param {ReturnType<typeof initialState>} state
 * @param {{seq:number, ts:string, type:string, actor:string, payload:any}} e
 */
export function apply(state, e) {
  if (e.seq <= state.seq) return state; // idempotent replay
  state.seq = e.seq;
  const p = e.payload || {};

  switch (e.type) {
    case 'station.loaded': {
      state.station = p.station;
      const next = {};
      for (const cfg of p.station.agents || []) {
        const prev = state.agents[cfg.id];
        next[cfg.id] = prev ? { ...prev, ...cfg } : agentDefaults(cfg);
      }
      state.agents = next;
      break;
    }
    case 'estop':
      state.estop = p.engaged;
      break;

    case 'agent.status': {
      const a = state.agents[p.agentId];
      if (!a) break;
      a.status = p.status;
      a.runId = p.runId ?? null;
      a.taskId = p.taskId ?? null;
      a.tool = p.tool ?? null;
      a.objectId = p.objectId ?? null;
      a.detail = p.detail ?? '';
      a.lastSeq = e.seq;
      break;
    }

    case 'task.created':
      state.tasks[p.taskId] = {
        ...p,
        kind: p.kind || 'work',
        dependsOn: p.dependsOn || [],
        inputs: p.inputs || [],
        status: 'queued',
        reason: '',
        outputs: [],
        summary: '',
        runIds: [],
        createdTs: e.ts,
        updatedTs: e.ts,
        createdSeq: e.seq,
      };
      state.taskOrder.push(p.taskId);
      break;
    case 'task.status': {
      const t = state.tasks[p.taskId];
      if (!t) break;
      t.status = p.status;
      t.reason = p.reason || '';
      if (p.outputs) t.outputs = p.outputs;
      if (p.summary) t.summary = p.summary;
      t.updatedTs = e.ts;
      break;
    }

    case 'run.started': {
      state.runs[p.runId] = { ...p, turns: 0, costUsd: 0, outcome: null, lastText: '', startedTs: e.ts, finishedTs: null };
      const t = state.tasks[p.taskId];
      if (t) t.runIds.push(p.runId);
      const a = state.agents[p.agentId];
      if (a) a.runs += 1;
      break;
    }
    case 'run.step': {
      const r = state.runs[p.runId];
      if (r) {
        r.turns = p.turn;
        r.costUsd += p.costUsd;
        if (p.text) r.lastText = p.text;
      }
      state.spend.totalUsd += p.costUsd;
      state.spend.steps += 1;
      addDay(state, e.ts, p.costUsd);
      state.spend.byAgent[p.agentId] = (state.spend.byAgent[p.agentId] || 0) + p.costUsd;
      const model = r?.model || 'unknown';
      state.spend.byModel[model] = (state.spend.byModel[model] || 0) + p.costUsd;
      const a = state.agents[p.agentId];
      if (a) a.spentUsd += p.costUsd;
      break;
    }
    case 'spend.recorded': {
      state.spend.totalUsd += p.usd;
      addDay(state, e.ts, p.usd);
      state.spend.byAgent[p.agentId] = (state.spend.byAgent[p.agentId] || 0) + p.usd;
      state.spend.byModel[p.model] = (state.spend.byModel[p.model] || 0) + p.usd;
      const a = state.agents[p.agentId];
      if (a) a.spentUsd += p.usd;
      const r = p.runId && state.runs[p.runId];
      if (r) r.costUsd += p.usd;
      break;
    }
    case 'run.finished': {
      const r = state.runs[p.runId];
      if (r) {
        r.outcome = p.outcome;
        r.summary = p.summary || '';
        r.error = p.error || '';
        r.finishedTs = e.ts;
      }
      break;
    }

    case 'approval.requested':
      state.approvals[p.approvalId] = { ...p, status: 'pending', requestedTs: e.ts, note: '' };
      break;
    case 'approval.resolved': {
      const ap = state.approvals[p.approvalId];
      if (ap) {
        ap.status = p.decision;
        ap.note = p.note || '';
        ap.resolvedTs = e.ts;
      }
      break;
    }

    case 'handoff':
      state.handoffs.push({ ...p, seq: e.seq, ts: e.ts });
      if (state.handoffs.length > HANDOFF_LIMIT) state.handoffs.splice(0, state.handoffs.length - HANDOFF_LIMIT);
      break;

    case 'artifact.created':
      state.artifacts[p.artifactId] = { ...p, createdTs: e.ts, seq: e.seq };
      state.artifactOrder.push(p.artifactId);
      break;

    case 'memory.written': {
      const ns = (state.memory[p.namespace] ||= { keys: {}, writes: 0 });
      ns.keys[p.key] = p.bytes;
      ns.writes += 1;
      break;
    }

    case 'ledger.entry': {
      const L = state.ledger;
      if (L.entries[p.entryId]) break;
      const extKey = p.source?.connector && p.source?.externalId ? `${p.source.connector}:${p.source.externalId}` : null;
      if (extKey && L.externalIds[extKey]) break; // already counted
      L.entries[p.entryId] = { ...p, seq: e.seq };
      L.entryOrder.push(p.entryId);
      if (extKey) L.externalIds[extKey] = p.entryId;
      applyLedger(L, p);
      break;
    }

    case 'connector.sync': {
      const c = (state.connectors[p.connector] ||= { syncs: 0 });
      Object.assign(c, { ok: p.ok, fetched: p.fetched, newEntries: p.newEntries, error: p.error || '', lastSyncTs: e.ts });
      c.syncs += 1;
      break;
    }

    case 'recipe.started':
      state.recipes[p.recipeRunId] = { ...p, startedTs: e.ts };
      break;
    case 'schedule.created':
      state.schedules[p.scheduleId] = { ...p, fired: 0, lastFiredTs: null };
      break;
    case 'schedule.fired': {
      const s = state.schedules[p.scheduleId];
      if (s) {
        s.fired += 1;
        s.lastFiredTs = e.ts;
      }
      break;
    }
    default:
      break;
  }

  if (e.type !== 'run.step' || p.text) {
    state.feed.push({ seq: e.seq, ts: e.ts, type: e.type, actor: e.actor, text: describe(e) });
    if (state.feed.length > FEED_LIMIT) state.feed.splice(0, state.feed.length - FEED_LIMIT);
  }
  return state;
}

/** Fold a list of events into a fresh state. */
export function project(events, state = initialState()) {
  for (const e of events) apply(state, e);
  return state;
}
