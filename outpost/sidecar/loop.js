// Agent loop: one run of one agent on one task.
//
// The tools offered to the model are computed from the station layout, every client tool call
// is re-checked against it before running, sensitive calls wait for the operator, and every
// provider step is priced. The run always ends with run.finished and the agent back to idle;
// task status beyond the approval pause belongs to the dispatcher.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { preview } from '../shared/events.js';
import { checkCall, toolsForAgent } from './capability.js';
import { newId } from './ids.js';
import { costOf, priceFor } from './pricing.js';
import { systemPrompt, taskMessage } from './prompts.js';

const MAX_TOKENS = 16000;
export const TOOL_RESULT_MAX_CHARS = 20000;
const DEFAULT_MAX_TURNS = 12;

class RunStop extends Error {
  constructor(outcome, message) {
    super(message);
    this.outcome = outcome;
  }
}

function textOf(content) {
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
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

function defaultSpendToday(store) {
  return () => store.state.spend.byDay[new Date().toISOString().slice(0, 10)] || 0;
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
  let turns = 0;
  let summary = '';
  let outcome;
  let error;
  const runCost = () => store.state.runs[runId]?.costUsd ?? 0;

  store.append('run.started', { runId, taskId, agentId: agent.id, provider: provider.name, model, effort: agent.effort, tools: [...offered] }, actor);
  setStatus('thinking');

  const ctx = {
    ...opts.ctxBase,
    store,
    dataDir,
    station,
    agent,
    task,
    runId,
    signal,
    workspaceDir: join(dataDir, 'workspaces', agent.id),
  };

  async function approve(tool, name, input, objectId) {
    const approvalId = newId('apr');
    let summaryLine;
    try {
      summaryLine = tool.summarize ? String(tool.summarize(input)) : '';
    } catch {
      summaryLine = '';
    }
    summaryLine = preview(summaryLine || `${name} ${preview(input, 160)}`, 300);
    store.append('approval.requested', { approvalId, runId, agentId: agent.id, taskId, tool: name, summary: summaryLine, input: preview(input, 2000) }, actor);
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

  async function executeCall(block) {
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

    setStatus('tool', { tool: name, objectId: check.objectId });
    store.append('tool.called', { runId, callId, agentId: agent.id, tool: name, objectId: check.objectId, input: inputPreview }, actor);
    const started = Date.now();
    let res;
    try {
      res = await tool.run(input, ctx);
    } catch (err) {
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

  function checkRunBudget() {
    const spent = runCost();
    if (spent > runBudget) throw new RunStop('budget_exceeded', `run cost $${spent.toFixed(4)} exceeded the $${runBudget} run budget`);
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
      const spentToday = stationSpendTodayUsd();
      if (spentToday >= dailyBudget) {
        throw new RunStop('budget_exceeded', `station daily budget reached ($${spentToday.toFixed(2)} of $${dailyBudget})`);
      }
      checkRunBudget(); // tool spend (e.g. images) since the last step counts too

      setStatus('thinking');
      const msg = await provider.createMessage({
        model,
        effort: agent.effort,
        system,
        tools,
        messages: [...messages],
        maxTokens: MAX_TOKENS,
        signal,
        agent,
        task,
      });
      turns += 1;
      messages.push({ role: 'assistant', content: msg.content });
      summary = textOf(msg.content);
      store.append('run.step', {
        runId,
        agentId: agent.id,
        turn: turns,
        stopReason: msg.stop_reason ?? 'unknown',
        usage: msg.usage ?? {},
        costUsd: costOf(model, msg.usage ?? {}),
        text: summary ? preview(summary, 600) : undefined,
      }, actor);

      checkRunBudget();

      switch (msg.stop_reason) {
        case 'end_turn':
        case 'stop_sequence':
          return;
        case 'refusal': {
          const d = msg.stop_details;
          throw new RunStop('refused', `model refused${d?.category ? ` (${d.category})` : ''}${d?.explanation ? `: ${d.explanation}` : ''}`);
        }
        case 'pause_turn':
          continue; // the server resumes from the trailing server-tool block; no extra user turn
        case 'max_tokens':
          throw new RunStop('failed', 'response hit max_tokens; tools on a truncated turn are not run');
        case 'tool_use': {
          const calls = msg.content.filter((b) => b.type === 'tool_use');
          if (!calls.length) throw new RunStop('failed', 'stop_reason tool_use without a tool_use block');
          const results = [];
          for (const call of calls) {
            signal?.throwIfAborted();
            results.push(await executeCall(call));
          }
          messages.push({ role: 'user', content: results });
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
    }, actor);
    store.append('agent.status', { agentId: agent.id, status: 'idle' }, actor);
  }
  return { outcome, turns, costUsd: runCost(), summary, outputs: [...outputs], ...(error ? { error } : {}) };
}
