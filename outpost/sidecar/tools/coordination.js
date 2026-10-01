// Coordination tools: command delegation (bridge only), peer handoff along hallways, and the
// task board. Lane rules are checked here against the layout and again by the dispatcher.

import { canDelegate, canHandoff } from '../capability.js';
import { checkArtifactIds } from './files.js';

const TASK_LIST_LIMIT = 30;
const SUMMARY_CHARS = 300;

async function route(kind, input, ctx) {
  const check = (kind === 'delegate' ? canDelegate : canHandoff)(ctx.station, ctx.agent.id, input.agent_id);
  if (!check.ok) return { ok: false, output: `${kind} refused: ${check.reason}` };
  const bad = checkArtifactIds(ctx, input.artifact_ids);
  if (bad) return { ok: false, output: `${kind} refused: ${bad}` };
  const res = await ctx.dispatcher[kind]({
    fromAgent: ctx.agent.id,
    toAgent: input.agent_id,
    title: input.title,
    brief: input.brief,
    artifactIds: input.artifact_ids,
    parentTaskId: ctx.task?.taskId,
  });
  if (!res?.ok) return { ok: false, output: `${kind} refused: ${res?.reason || 'dispatcher declined'}` };
  const via = check.route.length ? ` via ${check.route.join(' → ')}` : ' (same room)';
  return {
    ok: true,
    output: { task_id: res.taskId, assignee: input.agent_id, route: check.route, note: `Task ${res.taskId} queued for ${input.agent_id}${via}. Its results return to you as a review task.` },
  };
}

/** delegate_task: commander assigns work to any reachable agent. */
export const delegateTask = (input, ctx) => route('delegate', input, ctx);

/** handoff: pass work to a teammate in the same room or across one hallway. */
export const handoff = (input, ctx) => route('handoff', input, ctx);

/** list_tasks: recent tasks, newest first, optionally filtered by status. */
export async function listTasks(input, ctx) {
  const { tasks, taskOrder } = ctx.store.state;
  const rows = [];
  for (let i = taskOrder.length - 1; i >= 0 && rows.length < TASK_LIST_LIMIT; i -= 1) {
    const t = tasks[taskOrder[i]];
    if (input.status !== null && t.status !== input.status) continue;
    rows.push({
      task_id: t.taskId,
      title: t.title,
      assignee: t.assignee,
      status: t.status,
      kind: t.kind,
      created_by: t.createdBy,
      parent_task_id: t.parentTaskId ?? null,
      outputs: t.outputs,
      summary: t.summary.length > SUMMARY_CHARS ? `${t.summary.slice(0, SUMMARY_CHARS)}…` : t.summary,
      reason: t.reason,
    });
  }
  return { ok: true, output: { tasks: rows, total: taskOrder.length } };
}
