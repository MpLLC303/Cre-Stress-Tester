// Dispatcher: turns queued tasks into agent runs.
//
// It owns task lifecycle (queued -> running -> done | failed | cancelled), the rules for when
// a task may start (dependencies done, one run per agent, a station-wide concurrency cap, no
// E-STOP, daily budget left), routing of work between rooms (delegation, peer handoff, recipe
// stage inputs, review tasks back to the delegator), the operator's approval decisions, and
// crash recovery. Every decision it makes is an event; anything it must remember across a
// restart is derived from the projected state, never from memory.

import { canDelegate, canHandoff, route as hallwayRoute } from './capability.js';
import { newId } from './ids.js';
import { runAgentLoop } from './loop.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createScriptedProvider } from './providers/scripted.js';
import { DEFAULT_SCRIPTS } from './providers/scripts.js';
import { planRecipe } from './recipes.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const MAX_ATTEMPTS = 2;
// Delegation chains (task -> delegated task -> review -> revision -> ...) are capped so a
// disagreement between agents cannot loop forever; past this depth work goes back to the operator.
const MAX_CHAIN_DEPTH = 8;
const TITLE_MAX = 160;

const unique = (xs) => [...new Set(xs)];
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * One provider instance per sidecar, chosen by `config.provider`.
 * @param {{provider:'anthropic'|'scripted'}} config
 * @param {{scripts?:object}} [opts] scripts for the scripted provider (default: DEFAULT_SCRIPTS)
 * @returns {(agent:object) => {name:string, model?:string, createMessage:Function}}
 */
export function createProviderFor(config, { scripts = DEFAULT_SCRIPTS } = {}) {
  const provider = config.provider === 'anthropic' ? createAnthropicProvider() : createScriptedProvider({ scripts });
  return () => provider;
}

/**
 * @param {object} opts
 * @param {object} opts.store event store (sidecar/store.js)
 * @param {{dataDir:string, modelOverride?:string|null, tickMs?:number}} opts.config
 * @param {object} opts.station station layout
 * @param {(agent:object) => object} opts.providerFor provider for an agent's run
 * @param {object|null} [opts.imageProvider]
 * @param {{etsy?:object}} [opts.connectors]
 * @param {() => number} [opts.now] clock for the UTC day used by spendTodayUsd
 */
export function createDispatcher({ store, config, station, providerFor, imageProvider = null, connectors = {}, now = Date.now }) {
  const state = store.state;
  const maxRuns = station.budgets?.maxConcurrentRuns ?? 3;
  const dailyBudget = station.budgets?.stationDailyUsd ?? Infinity;
  /** agentId -> { taskId, agentId, runId, controller, stopReason } */
  const active = new Map();
  /** approvalId -> { resolve, reject } for runs paused on an approval gate */
  const waiters = new Map();
  let stopped = true;
  let timer = null;
  let tickQueued = false;
  let budgetHoldDay = null;
  let readOnlyLogged = false;

  const agentById = (id) => station.agents.find((a) => a.id === id) || null;
  const roomOfAgent = (id) => agentById(id)?.room ?? null;

  // ---- task records ------------------------------------------------------------------------

  /**
   * Queue a task. Throws on an unknown assignee, input artifact, dependency or parent.
   * @returns {string} taskId
   */
  function createTask({ assignee, title, brief, createdBy = 'operator', inputs = [], parentTaskId, dependsOn = [], recipeRunId, stage, kind = 'work' }) {
    if (!agentById(assignee)) throw new Error(`unknown agent "${assignee}"`);
    if (typeof title !== 'string' || !title.trim()) throw new Error('task title must be a non-empty string');
    if (typeof brief !== 'string') throw new Error('task brief must be a string');
    const missingInput = inputs.find((id) => !Object.hasOwn(state.artifacts, id));
    if (missingInput) throw new Error(`unknown artifact ${missingInput}`);
    const missingDep = dependsOn.find((id) => !Object.hasOwn(state.tasks, id));
    if (missingDep) throw new Error(`unknown dependency task ${missingDep}`);
    if (parentTaskId && !Object.hasOwn(state.tasks, parentTaskId)) throw new Error(`unknown parent task ${parentTaskId}`);
    const taskId = newId('task');
    store.append('task.created', {
      taskId,
      title: clip(title.trim(), TITLE_MAX),
      brief,
      assignee,
      createdBy,
      parentTaskId,
      recipeRunId,
      stage,
      dependsOn: unique(dependsOn),
      inputs: unique(inputs),
      kind,
    }, createdBy);
    queueTick();
    return taskId;
  }

  function setTaskStatus(taskId, status, extra = {}) {
    store.append('task.status', { taskId, status, ...extra }, 'system');
    if (!TERMINAL.has(status)) return;
    const task = state.tasks[taskId];
    maybeCreateReview(task.parentTaskId);
    maybeCreateReview(taskId);
  }

  /**
   * Re-queue a task whose run was cut short, unless it has used up its attempts. Runs the operator
   * halted (outcome 'aborted': E-STOP; cancelled tasks never get here) are not attempts.
   */
  function requeueOrFail(task, why) {
    const attempts = task.runIds.filter((id) => state.runs[id]?.outcome !== 'aborted').length;
    if (attempts < MAX_ATTEMPTS) setTaskStatus(task.taskId, 'queued', { reason: `${why}; re-queued (attempt ${attempts + 1} of ${MAX_ATTEMPTS})` });
    else setTaskStatus(task.taskId, 'failed', { reason: `${why}; gave up after ${attempts} attempts` });
  }

  function chainDepth(taskId) {
    let depth = 0;
    for (let id = taskId; id; id = state.tasks[id]?.parentTaskId) depth += 1;
    return depth;
  }

  // ---- routing between rooms -------------------------------------------------------------

  /** Announce work crossing to another agent; skipped when no hallway connects the rooms. */
  function emitHandoff({ fromAgent, toAgent, taskId, artifactIds, route }, actor) {
    const fromRoom = roomOfAgent(fromAgent);
    const toRoom = roomOfAgent(toAgent);
    const lane = route ?? hallwayRoute(station, fromRoom, toRoom);
    if (lane === null) return;
    store.append('handoff', { handoffId: newId('hof'), fromAgent, toAgent, fromRoom, toRoom, route: lane, taskId, artifactIds }, actor);
  }

  function routeWork(kind, { fromAgent, toAgent, title, brief, artifactIds = [], parentTaskId }) {
    const refuse = (reason) => ({ ok: false, taskId: null, reason });
    if (fromAgent === toAgent) return refuse(`cannot ${kind} to yourself`);
    const check = (kind === 'delegate' ? canDelegate : canHandoff)(station, fromAgent, toAgent);
    if (!check.ok) return refuse(check.reason);
    if (chainDepth(parentTaskId) + 1 > MAX_CHAIN_DEPTH) {
      return refuse(`this work is already ${MAX_CHAIN_DEPTH} hand-offs deep; report back to the operator instead of passing it on`);
    }
    let taskId;
    try {
      taskId = createTask({ assignee: toAgent, title, brief, createdBy: fromAgent, inputs: artifactIds, parentTaskId });
    } catch (err) {
      return refuse(err.message);
    }
    emitHandoff({ fromAgent, toAgent, taskId, artifactIds, route: check.route }, fromAgent);
    return { ok: true, taskId, reason: '' };
  }

  /** Command delegation from the bridge to any reachable agent. */
  const delegate = (args) => routeWork('delegate', args);
  /** Peer handoff within a room or across one hallway. */
  const handoff = (args) => routeWork('handoff', args);

  function reviewBrief(parent, children) {
    const done = children.filter((c) => c.status === 'done').length;
    return [
      `Work delegated from your task ${parent.taskId} "${parent.title}" has finished: ${done} of ${children.length} done, ${children.length - done} failed or cancelled.`,
      'Each result is under CHILD TASK RESULTS and every output is attached as an input artifact. Check them against your original brief below, then accept the work, delegate a revision with specific fixes, or report what could not be done. Do not re-request anything the operator denied.',
      `ORIGINAL BRIEF\n${parent.brief}`,
    ].join('\n\n');
  }

  /**
   * Once a parent is finished and every work task it spawned is terminal, its assignee gets
   * exactly one review task. "Already reviewed" is read from the log, so it survives restarts.
   * @returns {string|null} the review task id, if one was created
   */
  function maybeCreateReview(parentId, knownRelated = null) {
    const parent = parentId && state.tasks[parentId];
    if (!parent || !['done', 'failed'].includes(parent.status) || !agentById(parent.assignee)) return null;
    const related = knownRelated ?? state.taskOrder.map((id) => state.tasks[id]).filter((t) => t.parentTaskId === parentId);
    const children = related.filter((t) => t.kind === 'work');
    if (!children.length || related.some((t) => t.kind === 'review') || !children.every((t) => TERMINAL.has(t.status))) return null;
    const reviewId = createTask({
      assignee: parent.assignee,
      title: `Review: ${parent.title}`,
      brief: reviewBrief(parent, children),
      createdBy: 'system',
      inputs: children.flatMap((c) => c.outputs),
      parentTaskId: parentId,
      recipeRunId: parent.recipeRunId,
      kind: 'review',
    });
    for (const child of children) {
      if (roomOfAgent(child.assignee) !== roomOfAgent(parent.assignee)) {
        emitHandoff({ fromAgent: child.assignee, toAgent: parent.assignee, taskId: reviewId, artifactIds: child.outputs }, 'system');
      }
    }
    return reviewId;
  }

  /**
   * A stage task's inputs plus its dependencies' outputs. On the first attempt, outputs coming
   * from another room are announced as handoffs so the UI moves the packet along the hallways.
   */
  function stageInputs(task) {
    const deps = task.dependsOn.map((id) => state.tasks[id]);
    if (task.runIds.length === 0) {
      for (const dep of deps) {
        if (roomOfAgent(dep.assignee) !== roomOfAgent(task.assignee)) {
          emitHandoff({ fromAgent: dep.assignee, toAgent: task.assignee, taskId: task.taskId, artifactIds: dep.outputs }, 'system');
        }
      }
    }
    return unique([...task.inputs, ...deps.flatMap((d) => d.outputs)]);
  }

  /**
   * Start a recipe: one task per stage, each depending on the stages in its `after` list.
   * @returns {{recipeRunId:string, taskIds:string[]}}
   */
  function startRecipe(name, params = {}, createdBy = 'operator') {
    const plan = planRecipe(name, params);
    const unknown = plan.stages.find((s) => !agentById(s.agent));
    if (unknown) throw new Error(`recipe ${name} needs agent "${unknown.agent}", who is not on this station`);
    const recipeRunId = newId('rr');
    const taskIds = [];
    for (const stage of plan.stages) {
      taskIds.push(createTask({
        assignee: stage.agent,
        title: stage.title,
        brief: stage.brief,
        createdBy,
        dependsOn: stage.after.map((i) => taskIds[i]),
        recipeRunId,
        stage: stage.index,
      }));
    }
    store.append('recipe.started', { recipeRunId, recipe: name, title: plan.title, taskIds }, createdBy);
    return { recipeRunId, taskIds };
  }

  // ---- approvals ---------------------------------------------------------------------------

  function waitForApproval(approvalId, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const settle = (fn) => (value) => {
        waiters.delete(approvalId);
        signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const waiter = { resolve: settle(resolve), reject: settle(reject) };
      const onAbort = () => waiter.reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      waiters.set(approvalId, waiter);
    });
  }

  /**
   * Record the operator's decision and resume the paused run.
   * @param {string} approvalId
   * @param {'granted'|'denied'} decision
   * @param {string} [note]
   * @returns {boolean} false when no run is waiting on this approval
   */
  function resolveApproval(approvalId, decision, note) {
    const waiter = waiters.get(approvalId);
    if (!waiter || state.approvals[approvalId]?.status !== 'pending' || !['granted', 'denied'].includes(decision)) return false;
    store.append('approval.resolved', { approvalId, decision, note: note || undefined }, 'operator');
    waiter.resolve({ decision, note });
    return true;
  }

  // ---- runs --------------------------------------------------------------------------------

  /** True (logged once) when the event store failed a write: nothing new may start. */
  function readOnly() {
    const failed = store.health?.().failed;
    if (failed && !readOnlyLogged) {
      readOnlyLogged = true;
      console.error(`outpost dispatcher: store write failed; station is read-only (${failed}). No run starts until the sidecar restarts.`);
    }
    return Boolean(failed);
  }

  /**
   * External actions a halted run may already have taken: the approval-gated tools the operator
   * granted it (publish_listing, deliver_order), and receipts among its outputs. Re-running such a
   * task could repeat the action (e.g. a second Etsy draft), so it is never retried automatically.
   */
  function sideEffectsOf(runId, outputs = []) {
    const granted = unique(Object.values(state.approvals).filter((ap) => ap.runId === runId && ap.status === 'granted').map((ap) => ap.tool));
    const receipts = outputs.filter((id) => ['publish_receipt', 'delivery'].includes(state.artifacts[id]?.kind));
    return granted.length || receipts.length ? { granted, receipts } : null;
  }

  /** Model and image spend recorded today (UTC). */
  function spendTodayUsd() {
    return state.spend.byDay[utcDay(now())] || 0;
  }

  function dailyBudgetReached() {
    const spent = spendTodayUsd();
    if (spent < dailyBudget) return false;
    const day = utcDay(now());
    if (budgetHoldDay !== day) {
      budgetHoldDay = day;
      store.append('log', { level: 'warn', message: `Station daily budget reached ($${spent.toFixed(2)} of $${dailyBudget}): queued tasks wait for the next UTC day.` }, 'system');
    }
    return true;
  }

  /** Why a queued task can never start, or null. */
  function blockedReason(task) {
    if (!agentById(task.assignee)) return { status: 'failed', reason: `agent ${task.assignee} is not on this station` };
    for (const id of task.dependsOn) {
      const dep = state.tasks[id];
      if (dep.status === 'failed' || dep.status === 'cancelled') return { status: 'cancelled', reason: `dependency ${id} "${dep.title}" ${dep.status}` };
    }
    return null;
  }

  function startRun(task) {
    const agent = agentById(task.assignee);
    const inputs = stageInputs(task);
    const entry = { taskId: task.taskId, agentId: agent.id, runId: newId('run'), controller: new AbortController(), stopReason: null };
    active.set(agent.id, entry);
    setTaskStatus(task.taskId, 'running');
    execute(entry, agent, { ...task, inputs });
  }

  async function execute(entry, agent, task) {
    let result;
    try {
      const provider = providerFor(agent);
      result = await runAgentLoop({
        store,
        dataDir: config.dataDir,
        station,
        agent,
        task,
        runId: entry.runId,
        provider,
        model: provider.model ?? (config.modelOverride || agent.model),
        ctxBase,
        signal: entry.controller.signal,
        waitForApproval: (approvalId) => waitForApproval(approvalId, entry.controller.signal),
        stationSpendTodayUsd: spendTodayUsd,
        stationDailyBudgetUsd: dailyBudget,
      });
    } catch (err) {
      result = { outcome: 'failed', error: err?.message || String(err), outputs: [], summary: '' };
    }
    try {
      finish(entry, result);
    } catch (err) {
      if (!readOnly()) console.error(`outpost dispatcher: could not record the end of run ${entry.runId}:`, err);
      if (active.get(entry.agentId) === entry) active.delete(entry.agentId);
    }
  }

  function finish(entry, result) {
    if (active.get(entry.agentId) === entry) active.delete(entry.agentId);
    const task = state.tasks[entry.taskId];
    if (!TERMINAL.has(task.status)) {
      if (result.outcome === 'completed') {
        setTaskStatus(task.taskId, 'done', { outputs: result.outputs, summary: result.summary || undefined });
      } else if (result.outcome === 'aborted' && entry.stopReason === 'estop') {
        const fx = sideEffectsOf(entry.runId, result.outputs);
        if (fx) {
          const what = fx.granted.length ? `approved ${fx.granted.join(', ')}` : 'a receipt was recorded';
          setTaskStatus(task.taskId, 'failed', {
            outputs: result.outputs,
            reason: `halted by E-STOP after an external action had started (${what}); not retried automatically so it cannot run twice. Check the receipt and the marketplace (artifacts of run ${entry.runId}) before re-running.`,
          });
        } else {
          // An operator halt is not a failed attempt: the task waits for the release, however often.
          setTaskStatus(task.taskId, 'queued', { reason: 'halted by E-STOP; re-queued (operator halts do not use up attempts)' });
        }
      } else {
        setTaskStatus(task.taskId, 'failed', { reason: `${result.outcome}: ${result.error || 'no detail'}`, summary: result.summary || undefined });
      }
    }
    queueTick();
  }

  /**
   * Start every task that may start now. Synchronous: runs continue asynchronously.
   * @returns {string[]} ids of the tasks started
   */
  function tick() {
    if (stopped || readOnly()) return [];
    const started = [];
    for (const taskId of state.taskOrder) {
      const task = state.tasks[taskId];
      if (task.status !== 'queued') continue;
      const blocked = blockedReason(task);
      if (blocked) {
        setTaskStatus(taskId, blocked.status, { reason: blocked.reason });
        continue;
      }
      if (state.estop || active.size >= maxRuns || active.has(task.assignee)) continue;
      if (!task.dependsOn.every((id) => state.tasks[id].status === 'done')) continue;
      if (dailyBudgetReached()) continue;
      startRun(task);
      started.push(taskId);
    }
    return started;
  }

  function safeTick() {
    try {
      tick();
    } catch (err) {
      console.error('outpost dispatcher: tick failed:', err);
    }
  }

  function queueTick() {
    if (tickQueued || stopped) return;
    tickQueued = true;
    setImmediate(() => {
      tickQueued = false;
      safeTick();
    });
  }

  function abortRun(entry, stopReason) {
    entry.stopReason = stopReason;
    entry.controller.abort(new Error(stopReason === 'estop' ? 'E-STOP engaged' : 'task cancelled by the operator'));
  }

  /** Engage (abort every run, block starts) or release the emergency stop. */
  function setEstop(engaged) {
    const on = Boolean(engaged);
    if (state.estop !== on) store.append('estop', { engaged: on }, 'operator');
    if (on) for (const entry of active.values()) abortRun(entry, 'estop');
    else queueTick();
  }

  /**
   * Cancel a task that has not finished; its run, if any, is aborted.
   * @returns {boolean} false when the task is unknown or already finished
   */
  function cancelTask(taskId) {
    const task = state.tasks[taskId];
    if (!task || TERMINAL.has(task.status)) return false;
    setTaskStatus(taskId, 'cancelled', { reason: 'cancelled by the operator' });
    const entry = [...active.values()].find((e) => e.taskId === taskId);
    if (entry) abortRun(entry, 'cancelled');
    queueTick();
    return true;
  }

  /**
   * Boot-time repair after a crash or restart: nothing in the log may claim to be in flight
   * when no run is. Call before start().
   * @returns {{approvalsExpired:number, runsInterrupted:number, tasksCompleted:number, tasksRequeued:number, tasksFailed:number, agentsReset:number, reviewsCreated:number}}
   */
  function recover() {
    const liveRuns = new Set([...active.values()].map((e) => e.runId));
    const liveTasks = new Set([...active.values()].map((e) => e.taskId));
    const reviewCount = () => state.taskOrder.filter((id) => state.tasks[id].kind === 'review').length;
    const reviewsBefore = reviewCount();
    const summary = { approvalsExpired: 0, runsInterrupted: 0, tasksCompleted: 0, tasksRequeued: 0, tasksFailed: 0, agentsReset: 0, reviewsCreated: 0 };

    for (const ap of Object.values(state.approvals)) {
      if (ap.status !== 'pending' || liveRuns.has(ap.runId)) continue;
      store.append('approval.resolved', { approvalId: ap.approvalId, decision: 'expired', note: 'the sidecar restarted while this request was pending' }, 'system');
      summary.approvalsExpired += 1;
    }
    for (const run of Object.values(state.runs)) {
      if (run.outcome !== null || liveRuns.has(run.runId)) continue;
      store.append('run.finished', {
        runId: run.runId,
        agentId: run.agentId,
        taskId: run.taskId,
        outcome: 'interrupted',
        turns: run.turns,
        costUsd: run.costUsd,
        error: 'the sidecar stopped during this run',
      }, 'system');
      summary.runsInterrupted += 1;
    }
    // run.finished is appended before the dispatcher's task.status, and fsync is batched, so a
    // crash or power loss between the two leaves "run ended, task running". Close such a task the
    // way finish() would have instead of re-running it: a completed run's paid work, and any
    // external action it took (a granted publish), must not happen twice.
    let outputsByRun = null;
    const runOutputs = (runId) => {
      if (!outputsByRun) {
        outputsByRun = new Map();
        for (const art of Object.values(state.artifacts)) {
          if (!art.runId) continue;
          let list = outputsByRun.get(art.runId);
          if (!list) outputsByRun.set(art.runId, (list = []));
          list.push(art.artifactId);
        }
      }
      return outputsByRun.get(runId) || [];
    };
    for (const taskId of state.taskOrder) {
      const task = state.tasks[taskId];
      if ((task.status !== 'running' && task.status !== 'awaiting_approval') || liveTasks.has(taskId)) continue;
      const last = state.runs[task.runIds.at(-1)];
      if (last?.outcome === 'completed') {
        setTaskStatus(taskId, 'done', { outputs: runOutputs(last.runId), summary: last.summary || undefined, reason: 'run completed before the restart' });
        summary.tasksCompleted += 1;
        continue;
      }
      if (last && ['failed', 'budget_exceeded', 'max_turns', 'refused'].includes(last.outcome)) {
        setTaskStatus(taskId, 'failed', { reason: `${last.outcome}: ${last.error || 'no detail'}`, summary: last.summary || undefined });
        summary.tasksFailed += 1;
        continue;
      }
      requeueOrFail(task, 'interrupted by a sidecar restart');
      if (task.status === 'queued') summary.tasksRequeued += 1;
      else summary.tasksFailed += 1;
    }
    for (const agent of Object.values(state.agents)) {
      if (agent.status === 'idle' || active.has(agent.id)) continue;
      store.append('agent.status', { agentId: agent.id, status: 'idle', detail: 'reset after restart' }, 'system');
      summary.agentsReset += 1;
    }
    // Failing a task above may already have produced its parent's review; this catches the rest.
    // One indexed pass (parent -> its tasks), so boot stays linear in the number of tasks.
    const related = new Map();
    for (const id of state.taskOrder) {
      const t = state.tasks[id];
      if (!t.parentTaskId) continue;
      let list = related.get(t.parentTaskId);
      if (!list) related.set(t.parentTaskId, (list = []));
      list.push(t);
    }
    for (const [parentId, list] of related) {
      if (!list.some((t) => t.kind === 'review')) maybeCreateReview(parentId, list);
    }
    summary.reviewsCreated = reviewCount() - reviewsBefore;
    return summary;
  }

  /** Begin ticking every `config.tickMs`; runs also start as soon as work changes. */
  function start() {
    stopped = false;
    if (!timer) {
      timer = setInterval(safeTick, config.tickMs ?? 500);
      timer.unref();
    }
    queueTick();
  }

  /** Stop starting runs. Runs in flight are left alone; recover() repairs them on next boot. */
  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  const api = {
    start,
    stop,
    tick,
    createTask,
    delegate,
    handoff,
    startRecipe,
    resolveApproval,
    setEstop,
    cancelTask,
    recover,
    spendTodayUsd,
  };
  const ctxBase = { config, imageProvider, connectors, dispatcher: api };
  return api;
}
