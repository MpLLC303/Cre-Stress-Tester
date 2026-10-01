// Agent loop: one run of one agent on one task.
//
// The tools offered to the model are computed from the station layout, every client tool call
// is re-checked against it before running, sensitive calls wait for the operator, and every
// provider step is priced. The run always ends with run.finished and the agent back to idle;
// task status beyond the approval pause belongs to the dispatcher.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WEB_TAINT, preview } from '../shared/events.js';
import { isWebTainted } from '../shared/projector.js';
import { createTaint } from './artifacts.js';
import { checkCall, toolsForAgent } from './capability.js';
import { newId } from './ids.js';
import { costByModel, costOf, priceFor, servedModel, unpricedModels } from './pricing.js';
import { systemPrompt, taskMessage } from './prompts.js';

/**
 * Floor of the per-turn max_tokens the loop asks for when a budget binds (see turnMaxTokens): the
 * fixed value the loop used before, so a budget never makes a turn more likely to be cut off than
 * it was, and one turn overshoots the budget by no more than it could then.
 */
export const MIN_TURN_MAX_TOKENS = 16000;
export const TOOL_RESULT_MAX_CHARS = 20000;
const DEFAULT_MAX_TURNS = 12;

class RunStop extends Error {
  /** @param {string} [label] when set, the run's summary becomes `${label} ${message}` */
  constructor(outcome, message, label) {
    super(message);
    this.outcome = outcome;
    this.label = label;
  }
}

function textOf(content) {
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

/**
 * The latest non-empty thinking text of a turn. On models that write their between-tool notes as
 * thinking blocks, the provider asks for display 'updates', and these are those notes. Only the
 * text is read; the blocks themselves go back to the API verbatim and nowhere else.
 */
function progressNote(content) {
  for (let i = (content || []).length - 1; i >= 0; i -= 1) {
    const b = content[i];
    if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) return b.thinking.trim();
  }
  return '';
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  return JSON.stringify(output);
}

/** Cap at `max` chars total, notice included. */
function truncate(s, max) {
  if (s.length <= max) return s;
  const keep = max - 64;
  return `${s.slice(0, keep)}\n…[truncated, ${s.length - keep} more chars]`;
}

/** Error text for the log; SDK API errors keep their class and HTTP status. */
function errorMessage(err) {
  const msg = err instanceof Error ? err.message : String(err);
  const status = err?.status;
  const withStatus = status && !msg.startsWith(String(status)) ? `${status} ${msg}` : msg;
  const kind = err?.constructor?.name;
  return kind && kind !== 'Error' && typeof status === 'number' ? `${kind}: ${withStatus}` : withStatus;
}

function isAbort(err, signal) {
  return signal?.aborted || err?.name === 'AbortError';
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts. A tool that ignores the signal (or a
 * request that hangs) then cannot pin a halted run: the run ends at once and the tool, if it ever
 * returns, finishes in the background.
 */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('run aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function defaultSpendToday(store) {
  return () => store.state.spend.byDay[new Date().toISOString().slice(0, 10)] || 0;
}

const WEB_TOOLS = new Set(['web_search', 'web_fetch']);
const WEB_RESULTS = new Set(['web_search_tool_result', 'web_fetch_tool_result']);

/** True when an assistant turn used the web: a web server-tool call or its result block. */
export function usesWeb(content) {
  return (content || []).some((b) => (b?.type === 'server_tool_use' && WEB_TOOLS.has(b.name)) || WEB_RESULTS.has(b?.type));
}

/**
 * Why a run starts web-tainted: its tainted input artifacts and, for a review task, the tainted
 * runs of the work it reviews (their summaries are in the prompt even when they left no artifact).
 */
export function initialTaintSources(state, task) {
  const sources = (task.inputs || []).filter((id) => isWebTainted(state.artifacts[id]));
  if (task.kind === 'review' && task.parentTaskId) {
    for (const id of state.taskOrder) {
      const t = state.tasks[id];
      if (t.taskId === task.taskId || t.kind === 'review' || t.parentTaskId !== task.parentTaskId) continue;
      for (const runId of t.runIds) if (isWebTainted(state.runs[runId])) sources.push(runId);
    }
  }
  return sources;
}

/** Existing artifacts a tool input names directly (top-level strings and string arrays). */
function referencedArtifacts(state, input) {
  const ids = [];
  for (const value of Object.values(input && typeof input === 'object' ? input : {})) {
    for (const v of [].concat(value)) if (typeof v === 'string' && Object.hasOwn(state.artifacts, v)) ids.push(v);
  }
  return ids;
}

/**
 * Run an agent on a task until it finishes, fails, or hits a limit.
 * @param {object} opts
 * @param {object} opts.store event store (sidecar/store.js)
 * @param {string} opts.dataDir
 * @param {object} opts.station station layout
 * @param {object} opts.agent station agent config ({id, model, effort, maxTurns, runBudgetUsd, ...})
 * @param {object} opts.task task as projected in state.tasks
 * @param {string} opts.runId
 * @param {{name:string, model?:string, createMessage:Function}} opts.provider a provider with a fixed
 *   `model` (the scripted one) overrides the agent's model
 * @param {string} [opts.model] model override for this run (config.modelOverride)
 * @param {object} [opts.ctxBase] tool ctx shared across runs (config, imageProvider, connectors, dispatcher)
 * @param {AbortSignal} [opts.signal] E-STOP / cancel
 * @param {(approvalId:string) => Promise<{decision:string, note?:string}>} opts.waitForApproval
 *   rejects on abort; the loop marks a still-pending approval expired when that happens
 * @param {() => number} [opts.stationSpendTodayUsd]
 * @param {number} [opts.stationDailyBudgetUsd]
 * @param {{TOOLS:object, toolDefinitions:Function, validateInput:Function}} [opts.toolset]
 *   defaults to ./tools/index.js
 * @returns {Promise<{outcome:string, turns:number, costUsd:number, summary:string, outputs:string[], error?:string}>}
 */
export async function runAgentLoop(opts) {
  const { store, dataDir, station, agent, task, runId, provider, signal, waitForApproval } = opts;
  const toolset = opts.toolset ?? (await import('./tools/index.js'));
  const stationSpendTodayUsd = opts.stationSpendTodayUsd ?? defaultSpendToday(store);
  const dailyBudget = opts.stationDailyBudgetUsd ?? station.budgets?.stationDailyUsd ?? Infinity;
  const runBudget = agent.runBudgetUsd ?? Infinity;
  const maxTurns = agent.maxTurns ?? DEFAULT_MAX_TURNS;
  const model = provider.model ?? opts.model ?? agent.model;
  const taskId = task.taskId;
  const actor = agent.id;

  // Scripted runs never offer server tools: the scripted provider cannot execute them.
  const grants = toolsForAgent(station, agent.id).filter((g) => {
    const tool = toolset.TOOLS[g.tool];
    return tool && !(provider.name === 'scripted' && tool.kind === 'server');
  });
  const offered = new Set(grants.map((g) => g.tool));

  // Skips the event when the projected agent already shows exactly this status, so a
  // pause_turn continuation does not spam the log; other writers (the dispatcher) stay visible.
  const setStatus = (status, extra = {}) => {
    const payload = { agentId: agent.id, status, runId, taskId, ...extra };
    const cur = store.state.agents[agent.id];
    const same = cur && cur.status === status && cur.runId === runId && cur.taskId === taskId &&
      cur.tool === (payload.tool ?? null) && cur.objectId === (payload.objectId ?? null) && cur.detail === (payload.detail ?? '');
    if (!same) store.append('agent.status', payload, actor);
  };

  const outputs = new Set();
  const servedModels = new Set();
  let turns = 0;
  let summary = '';
  let outcome;
  let error;
  const runCost = () => store.state.runs[runId]?.costUsd ?? 0;

  /**
   * Why no more money may be spent in this run (the station daily budget, then the run budget), or
   * null. Checked before every provider call AND before every tool call, so one turn of parallel
   * paid tool calls (e.g. generate_image) overshoots by at most one call.
   */
  function budgetBlock() {
    const spentToday = stationSpendTodayUsd();
    if (spentToday >= dailyBudget) return `station daily budget reached ($${spentToday.toFixed(2)} of $${dailyBudget})`;
    const spent = runCost();
    if (spent > runBudget) return `run cost $${spent.toFixed(4)} exceeded the $${runBudget} run budget`;
    return null;
  }

  store.append('run.started', { runId, taskId, agentId: agent.id, provider: provider.name, model, effort: agent.effort, tools: [...offered] }, actor);
  setStatus('thinking');

  // Web taint (see createTaint): tools consult it when they write, and mark it when they read.
  const taint = createTaint(initialTaintSources(store.state, task));
  const ctx = {
    ...opts.ctxBase,
    store,
    dataDir,
    station,
    agent,
    task,
    runId,
    signal,
    taint,
    budgetBlock, // tools that spend (generate_image) refuse up front when it returns a reason
    budgetRemainingUsd: () => Math.min(runBudget - runCost(), dailyBudget - stationSpendTodayUsd()),
    workspaceDir: join(dataDir, 'workspaces', agent.id),
  };

  async function approve(tool, name, input, objectId) {
    const approvalId = newId('apr');
    let summaryLine;
    try {
      // ctx lets the summary say what granting will really do (e.g. Etsy draft vs dry run).
      summaryLine = tool.summarize ? String(tool.summarize(input, ctx)) : '';
    } catch {
      summaryLine = '';
    }
    summaryLine = preview(summaryLine || `${name} ${preview(input, 160)}`, 300);
    // Acting on a tainted artifact counts as reading it, so the operator sees the taint even if
    // the model only learned the id.
    for (const id of referencedArtifacts(store.state, input)) if (isWebTainted(store.state.artifacts[id])) taint.add(id);
    store.append('approval.requested', { approvalId, runId, agentId: agent.id, taskId, tool: name, summary: summaryLine, input: preview(input, 2000), ...taint.fields() }, actor);
    setStatus('awaiting_approval', { tool: name, objectId, detail: summaryLine });
    store.append('task.status', { taskId, status: 'awaiting_approval', reason: summaryLine }, actor);
    let resolution;
    try {
      resolution = await waitForApproval(approvalId);
    } catch (err) {
      if (store.state.approvals[approvalId]?.status === 'pending') {
        store.append('approval.resolved', { approvalId, decision: 'expired', note: 'run stopped while waiting' }, actor);
      }
      throw err;
    }
    store.append('task.status', { taskId, status: 'running' }, actor);
    return resolution;
  }

  /** @param {string} [note] the turn's visible text or progress note, shown while the tool runs */
  async function executeCall(block, note) {
    const { id: callId, name, input } = block;
    const deny = (reason) => {
      store.append('tool.denied', { runId, callId, agentId: agent.id, tool: name, reason }, actor);
      return { type: 'tool_result', tool_use_id: callId, content: reason, is_error: true };
    };

    const check = checkCall(station, agent.id, name);
    if (!check.ok) return deny(check.reason);
    const tool = toolset.TOOLS[name];
    if (!tool || !offered.has(name)) return deny(`"${name}" is not available in this run`);
    if (tool.kind === 'server') return deny(`"${name}" runs on the provider and cannot be executed locally`);

    const inputPreview = preview(input);
    const invalid = toolset.validateInput(tool, input);
    if (invalid) {
      const output = `invalid input: ${invalid}`;
      store.append('tool.called', { runId, callId, agentId: agent.id, tool: name, objectId: check.objectId, input: inputPreview }, actor);
      store.append('tool.result', { runId, callId, agentId: agent.id, tool: name, ok: false, output, durationMs: 0 }, actor);
      return { type: 'tool_result', tool_use_id: callId, content: output, is_error: true };
    }

    if (tool.sensitivity === 'approval') {
      const { decision, note } = await approve(tool, name, input, check.objectId);
      if (decision !== 'granted') return deny(`operator denied: ${note || decision}`);
    }

    signal?.throwIfAborted(); // never start a tool for a halted run
    setStatus('tool', { tool: name, objectId: check.objectId, ...(note ? { detail: preview(note, 200) } : {}) });
    store.append('tool.called', { runId, callId, agentId: agent.id, tool: name, objectId: check.objectId, input: inputPreview }, actor);
    const started = Date.now();
    const running = Promise.resolve().then(() => tool.run(input, ctx));
    running.catch(() => {}); // a late failure after a halt is not an unhandled rejection
    let res;
    try {
      res = await untilAborted(running, signal);
    } catch (err) {
      if (signal?.aborted) {
        store.append('tool.result', {
          runId,
          callId,
          agentId: agent.id,
          tool: name,
          ok: false,
          output: 'halted while running: the run stopped before this tool returned. A request already in flight may still complete; anything the tool records later carries this run id.',
          durationMs: Date.now() - started,
        }, actor);
        throw err;
      }
      res = { ok: false, output: `tool error: ${errorMessage(err)}` };
    }
    const ok = res?.ok === true;
    const text = outputText(res?.output) || (ok ? '(no output)' : '(failed without output)');
    for (const id of res?.artifactIds || []) outputs.add(id);
    store.append('tool.result', { runId, callId, agentId: agent.id, tool: name, ok, output: preview(text), durationMs: Date.now() - started }, actor);
    const result = { type: 'tool_result', tool_use_id: callId, content: truncate(text, TOOL_RESULT_MAX_CHARS) };
    if (!ok) result.is_error = true;
    return result;
  }

  function checkBudgets() {
    const blocked = budgetBlock();
    if (blocked) throw new RunStop('budget_exceeded', blocked);
  }

  /**
   * max_tokens for the next turn: what the remaining run/daily budget buys at the model's output
   * rate, never below MIN_TURN_MAX_TOKENS; undefined (the provider's own ceiling) when no budget
   * binds or the model is free. Thinking counts toward max_tokens, so an always-thinking model needs
   * room, but one turn at a 64K ceiling could otherwise overshoot a small run budget by far more
   * than the budget itself.
   */
  function turnMaxTokens() {
    const perMTok = priceFor(model).output;
    const remaining = ctx.budgetRemainingUsd();
    if (!(perMTok > 0) || !Number.isFinite(remaining)) return undefined;
    return Math.max(MIN_TURN_MAX_TOKENS, Math.floor((remaining * 1_000_000) / perMTok));
  }

  /**
   * A provider attempt that was billed but discarded (the SDK could not parse a streamed tool
   * input and the provider re-issued the turn): recorded as its own step so its cost counts.
   */
  function recordDiscarded({ usage } = {}) {
    const u = usage && typeof usage === 'object' ? usage : {};
    store.append('run.step', { runId, agentId: agent.id, turn: turns + 1, stopReason: 'discarded_invalid_tool_json', usage: u, costUsd: costOf(model, u) }, actor);
    // The SDK's error text carries the model's partial tool JSON: discarded output, not logged.
    store.append('log', { level: 'warn', message: `run ${runId}: turn ${turns + 1} re-issued, the streamed tool input was not parseable JSON; the attempt's reported usage is billed to this run` }, actor);
  }

  /** Drive provider turns until the run completes (resolves) or stops (throws). */
  async function drive() {
    priceFor(model);
    mkdirSync(ctx.workspaceDir, { recursive: true });
    const tools = offered.size ? toolset.toolDefinitions([...offered]) : [];
    const system = systemPrompt(station, agent, grants);
    const messages = [{ role: 'user', content: taskMessage({ store, dataDir }, task) }];

    for (;;) {
      signal?.throwIfAborted();
      if (turns >= maxTurns) throw new RunStop('max_turns', `reached the ${maxTurns}-turn limit`);
      checkBudgets(); // tool spend (e.g. images) since the last step counts too

      setStatus('thinking');
      const msg = await provider.createMessage({
        model,
        effort: agent.effort,
        system,
        tools,
        messages: [...messages],
        maxTokens: turnMaxTokens(),
        signal,
        agent,
        task,
        onDiscardedAttempt: recordDiscarded,
      });
      turns += 1;
      messages.push({ role: 'assistant', content: msg.content });
      if (usesWeb(msg.content)) taint.add(WEB_TAINT);
      const turnText = textOf(msg.content);
      // A refused or max_tokens turn can stop mid-sentence: its partial output is discarded, never
      // shown or passed on as a result (the run's summary says what happened instead).
      const cut = msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens';
      if (!cut) summary = turnText; // the summary is visible text only, never thinking
      // What the step shows: the visible text, else the model's latest progress note.
      const note = cut ? '' : turnText || progressNote(msg.content);
      // Priced before the event is built: the call is already paid for, so run.step is always
      // recorded (an unlisted fallback model is billed at the highest known rate, never skipped).
      const usage = msg.usage ?? {};
      const costUsd = costOf(model, usage);
      const fallback = Array.isArray(usage.iterations) && usage.iterations.some((it) => it?.type === 'fallback_message');
      const served = servedModel(model, usage, msg.model);
      if (served) servedModels.add(served);
      store.append('run.step', {
        runId,
        agentId: agent.id,
        turn: turns,
        stopReason: msg.stop_reason ?? 'unknown',
        usage,
        costUsd,
        text: note ? preview(note, 600) : undefined,
        ...(fallback ? { costByModel: costByModel(model, usage) } : {}),
        ...(served ? { servedModel: served } : {}),
      }, actor);
      const unpriced = unpricedModels(usage);
      if (unpriced.length) {
        store.append('log', { level: 'warn', message: `run ${runId}: fallback model(s) ${unpriced.join(', ')} have no price in sidecar/pricing.js; this step was billed at the highest known rate` }, actor);
      }

      checkBudgets();

      switch (msg.stop_reason) {
        case 'end_turn':
        case 'stop_sequence':
          return;
        case 'refusal': {
          const d = msg.stop_details;
          throw new RunStop('refused', `model refused${d?.category ? ` (${d.category})` : ''}${d?.explanation ? `: ${d.explanation}` : ''}`, '[refused]');
        }
        case 'pause_turn':
          continue; // the server resumes from the trailing server-tool block; no extra user turn
        case 'max_tokens':
          throw new RunStop('failed', 'response hit max_tokens; tools on a truncated turn are not run', '[truncated]');
        case 'tool_use': {
          const calls = msg.content.filter((b) => b.type === 'tool_use');
          if (!calls.length) throw new RunStop('failed', 'stop_reason tool_use without a tool_use block');
          const results = [];
          let stop = null;
          for (const call of calls) {
            signal?.throwIfAborted();
            // Budgets are re-checked before every call: earlier calls this turn may have spent.
            stop ??= budgetBlock();
            if (stop) {
              const reason = `budget exceeded, not run: ${stop}`;
              store.append('tool.denied', { runId, callId: call.id, agentId: agent.id, tool: call.name, reason }, actor);
              results.push({ type: 'tool_result', tool_use_id: call.id, content: reason, is_error: true });
              continue;
            }
            results.push(await executeCall(call, note));
          }
          messages.push({ role: 'user', content: results });
          if (stop) throw new RunStop('budget_exceeded', stop);
          continue;
        }
        default:
          throw new RunStop('failed', `unexpected stop_reason ${msg.stop_reason}`);
      }
    }
  }

  try {
    await drive();
    outcome = 'completed';
  } catch (err) {
    if (err instanceof RunStop) {
      outcome = err.outcome;
      error = err.message;
      // Explicit, so the task card and a reviewing commander never read it as a result.
      if (err.label) summary = `${err.label} ${err.message}`;
    } else if (isAbort(err, signal)) {
      outcome = 'aborted';
      error = 'run aborted';
    } else {
      outcome = 'failed';
      error = errorMessage(err);
    }
  } finally {
    store.append('run.finished', {
      runId,
      agentId: agent.id,
      taskId,
      outcome,
      turns,
      costUsd: runCost(),
      summary: summary || undefined,
      error,
      servedModels: servedModels.size ? [...servedModels] : undefined,
      ...taint.fields(),
    }, actor);
    store.append('agent.status', { agentId: agent.id, status: 'idle' }, actor);
  }
  return { outcome, turns, costUsd: runCost(), summary, outputs: [...outputs], ...(error ? { error } : {}) };
}
