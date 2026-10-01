// Scheduler: recurring recipes and tasks. Schedules live in the event log (schedule.created),
// so a restart restores them from state; each firing is logged as schedule.fired.
//
// Specs: `every <n>m` / `every <n>h`, or 5-field cron (minute hour day-of-month month
// day-of-week, UTC) with `*`, `*/n`, `a`, `a-b` and comma lists. Cron schedules miss runs that
// fall while the sidecar is down; they do not catch up.

import { newId } from './ids.js';
import { planRecipe } from './recipes.js';

const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 }, // 0 and 7 are both Sunday
];
const MINUTE_MS = 60_000;

function parseField(text, { name, min, max }) {
  const values = new Set();
  for (const part of text.split(',')) {
    const step = part.match(/^\*\/(\d+)$/);
    const range = part.match(/^(\d+)-(\d+)$/);
    let lo;
    let hi;
    let by = 1;
    if (part === '*') [lo, hi] = [min, max];
    else if (step) [lo, hi, by] = [min, max, Number(step[1])];
    else if (range) [lo, hi] = [Number(range[1]), Number(range[2])];
    else if (/^\d+$/.test(part)) lo = hi = Number(part);
    else throw new Error(`cron ${name}: cannot parse "${part}"`);
    if (by < 1) throw new Error(`cron ${name}: step must be at least 1`);
    if (lo < min || hi > max || lo > hi) throw new Error(`cron ${name}: "${part}" is outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += by) values.add(name === 'day-of-week' && v === 7 ? 0 : v);
  }
  return values;
}

/**
 * Parse a schedule spec.
 * @param {string} spec
 * @returns {{kind:'interval', spec:string, ms:number} |
 *   {kind:'cron', spec:string, minute:Set<number>, hour:Set<number>, dom:Set<number>, month:Set<number>, dow:Set<number>, domAny:boolean, dowAny:boolean}}
 * @throws {Error} when the spec is invalid
 */
export function parseSpec(spec) {
  const text = String(spec ?? '').trim().replace(/\s+/g, ' ');
  const every = text.match(/^every (\d+) ?(m|h)$/i);
  if (every) {
    const n = Number(every[1]);
    if (n < 1) throw new Error('interval must be at least 1');
    return { kind: 'interval', spec: `every ${n}${every[2].toLowerCase()}`, ms: n * (every[2].toLowerCase() === 'h' ? 60 : 1) * MINUTE_MS };
  }
  const parts = text.split(' ');
  if (parts.length !== 5) throw new Error(`schedule spec must be "every <n>m|h" or a 5-field cron expression, got "${text}"`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, CRON_FIELDS[i]));
  return { kind: 'cron', spec: text, minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

/** Does a cron spec match the UTC minute containing `ms`? Standard rule: when both day fields are restricted, either may match. */
export function cronMatches(cron, ms) {
  const d = new Date(ms);
  if (!cron.minute.has(d.getUTCMinutes()) || !cron.hour.has(d.getUTCHours()) || !cron.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = cron.dom.has(d.getUTCDate());
  const dowOk = cron.dow.has(d.getUTCDay());
  if (cron.domAny || cron.dowAny) return domOk && dowOk;
  return domOk || dowOk;
}

function validateTemplate(template, state) {
  if (template === null || typeof template !== 'object' || Array.isArray(template)) throw new Error('template must be an object');
  if (typeof template.recipe === 'string') {
    planRecipe(template.recipe, template.params ?? {}); // throws on an unknown recipe or bad params
    return;
  }
  const t = template.task;
  if (!t || typeof t !== 'object') throw new Error('template needs {recipe, params} or {task: {assignee, title, brief}}');
  for (const key of ['assignee', 'title', 'brief']) {
    if (typeof t[key] !== 'string' || !t[key].trim()) throw new Error(`template.task.${key} must be a non-empty string`);
  }
  if (state.station && !state.agents[t.assignee]) throw new Error(`unknown agent "${t.assignee}"`);
}

/**
 * @param {{store:object, dispatcher:{startRecipe:Function, createTask:Function}, now?:() => number, intervalMs?:number}} opts
 * @returns {{addSchedule:(spec:string, template:object, actor?:string) => string, tick:() => string[], start:() => void, stop:() => void}}
 */
export function createScheduler({ store, dispatcher, now = Date.now, intervalMs = 10_000 }) {
  const compiled = new Map(); // scheduleId -> parsed spec (null when the stored spec is invalid)
  const anchors = new Map(); // scheduleId -> ms an interval counts from
  const lastMinute = new Map(); // scheduleId -> UTC minute index of the last firing
  let timer = null;

  function track(s, anchorMs) {
    let parsed = null;
    try {
      parsed = parseSpec(s.spec);
    } catch (err) {
      store.append('log', { level: 'warn', message: `schedule ${s.scheduleId} ignored: ${err.message}` }, 'scheduler');
    }
    compiled.set(s.scheduleId, parsed);
    anchors.set(s.scheduleId, anchorMs);
    return parsed;
  }

  // Restore: intervals resume from their last firing, or from now if they never fired.
  for (const s of Object.values(store.state.schedules)) {
    track(s, s.lastFiredTs ? Date.parse(s.lastFiredTs) : now());
    if (s.lastFiredTs) lastMinute.set(s.scheduleId, Math.floor(Date.parse(s.lastFiredTs) / MINUTE_MS));
  }

  function addSchedule(spec, template, actor = 'operator') {
    const parsed = parseSpec(spec);
    validateTemplate(template, store.state);
    const scheduleId = newId('sch');
    store.append('schedule.created', { scheduleId, spec: parsed.spec, template, enabled: true }, actor);
    compiled.set(scheduleId, parsed);
    anchors.set(scheduleId, now());
    return scheduleId;
  }

  function isDue(id, parsed, t) {
    if (parsed.kind === 'cron') return cronMatches(parsed, t);
    return t - anchors.get(id) >= parsed.ms;
  }

  function fire(s) {
    const { template } = s;
    if (typeof template.recipe === 'string') return dispatcher.startRecipe(template.recipe, template.params || {}, 'scheduler').taskIds;
    const { assignee, title, brief } = template.task;
    return [dispatcher.createTask({ assignee, title, brief, createdBy: 'scheduler' })];
  }

  /** Fire every due schedule at most once per UTC minute. @returns {string[]} ids of schedules that fired */
  function tick() {
    if (store.state.estop) return []; // E-STOP: nothing new starts, and nothing piles up behind it
    const t = now();
    const minute = Math.floor(t / MINUTE_MS);
    const fired = [];
    for (const s of Object.values(store.state.schedules)) {
      if (!s.enabled) continue;
      const parsed = compiled.has(s.scheduleId) ? compiled.get(s.scheduleId) : track(s, t);
      if (!parsed || lastMinute.get(s.scheduleId) === minute || !isDue(s.scheduleId, parsed, t)) continue;
      // Mark first, so a failing template is retried at its next due time, not on every tick.
      lastMinute.set(s.scheduleId, minute);
      anchors.set(s.scheduleId, t);
      try {
        store.append('schedule.fired', { scheduleId: s.scheduleId, taskIds: fire(s) }, 'scheduler');
        fired.push(s.scheduleId);
      } catch (err) {
        store.append('log', { level: 'error', message: `schedule ${s.scheduleId} failed to fire: ${err.message}` }, 'scheduler');
      }
    }
    return fired;
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { addSchedule, tick, start, stop };
}
