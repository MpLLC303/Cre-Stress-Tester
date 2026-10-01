// Station UI: top bar, terminal panel, event feed, approvals, artifact viewer.
//
// The law: nothing here asserts state the runtime cannot prove. Every figure is read from
// client.state (a projector fold of the event log) or client.meta (the server's own
// description of itself). Actions POST to the runtime and then WAIT for the resulting
// event; the UI never optimistically flips state. DOM is built with createElement +
// textContent only: model, artifact and config strings never reach innerHTML.

import { anthropicStatus, coverageCaveat, entryCurrency, evidenceCoverage, isWebTainted, netCents } from '/shared/projector.js';
import { OBJECT_GRANTS, INTRINSIC_TOOLS } from '/shared/grants.js';

const RECIPES = ['pod_listing', 'thumbnail_order', 'competitor_scan', 'ledger_report'];
const FEED_SHOW = 40;
const TERMINAL_TASK = new Set(['done', 'failed', 'cancelled']);
const TASK_GROUPS = [
  ['running', 'RUNNING'],
  ['awaiting_approval', 'AWAITING APPROVAL'],
  ['queued', 'QUEUED'],
  ['done', 'DONE'],
  ['failed', 'FAILED'],
  ['cancelled', 'CANCELLED'],
];
const GROUP_LIMIT = 8;
const STATUS_LABEL = {
  idle: 'IDLE',
  thinking: 'THINKING',
  tool: 'TOOL',
  awaiting_approval: 'AWAITING APPROVAL',
  handoff: 'HANDOFF',
  error: 'ERROR',
  paused: 'PAUSED',
};
const KIND_LABEL = {
  text: 'TEXT',
  json: 'JSON',
  svg: 'SVG',
  image: 'IMAGE',
  listing_draft: 'LISTING',
  package: 'PACKAGE',
  delivery: 'DELIVERY',
  publish_receipt: 'RECEIPT',
};
const TEXT_LIMIT = 256 * 1024;
const J = JSON.stringify;

// ---------------------------------------------------------------------------------------
// DOM helpers (no innerHTML anywhere)

function add(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false || kid === '') continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'value') el.value = v;
      else if (k === 'k') el.dataset.k = v;
      else if (k === 'on') for (const [evt, fn] of Object.entries(v)) el.addEventListener(evt, fn);
      else if (k === 'vars') {
        for (const [name, val] of Object.entries(v)) if (val) el.style.setProperty(name, String(val));
      } else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  return add(el, kids);
}

/** Replace children, restoring keyboard focus to the element with the same data-k. */
function swap(el, nodes) {
  const active = document.activeElement;
  const key = active && el.contains(active) ? active.dataset.k : null;
  el.replaceChildren();
  add(el, [nodes]);
  if (key) {
    const again = el.querySelector(`[data-k="${CSS.escape(key)}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

/** A block re-rendered only when its signature (a cheap string of the data it shows) changes. */
function live(tag, props, sig, render) {
  const block = {
    el: h(tag, props),
    last: undefined,
    update(force = false) {
      const s = sig();
      if (!force && s === block.last) return;
      block.last = s;
      swap(block.el, render());
    },
  };
  return block;
}

function sec(title, note, ...kids) {
  return h(
    'section',
    { class: 'sec' },
    h('h3', { class: 'sec-title' }, h('span', { text: title }), note ? h('span', { class: 'sec-note', text: note }) : null),
    ...kids,
  );
}

const empty = (text) => h('p', { class: 'empty', text });

function kv(rows) {
  return h(
    'dl',
    { class: 'kv' },
    rows.filter(Boolean).map(([k, v, title]) => [h('dt', { text: k }), h('dd', { title: title || null }, v)]),
  );
}

// ---------------------------------------------------------------------------------------
// Formatting

function usd(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const digits = abs > 0 && abs < 1 ? 4 : 2;
  return `${v < 0 ? '−' : ''}$${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
function cents(c) {
  const v = Number(c) || 0;
  return `${v < 0 ? '−' : ''}$${(Math.abs(v) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const negCents = (c) => (Number(c) ? `−${cents(c)}` : cents(0));
/** An amount in its own currency (minor units ×100, as the ledger stores them); USD keeps '$'. */
function money(c, currency = 'USD') {
  if (currency === 'USD') return cents(c);
  const v = (Number(c) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code' }).format(v).replace('-', '−');
  } catch {
    return `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} ${currency}`;
  }
}
/** Floor, so coverage is never overstated. */
const pct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${Math.floor(x * 100)}%`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pad2 = (n) => String(n).padStart(2, '0');
function hms(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function ymd(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts || '—').slice(0, 10);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const stamp = (ts) => (ts ? `${ymd(ts)} ${hms(ts)}` : '—');
const utcDay = () => new Date().toISOString().slice(0, 10);
function bytesFmt(b) {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}
const clip = (s, n) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};
function prettyMaybeJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------------------
// State readers (pure functions of projector state)

const roomById = (st, id) => st.station?.rooms?.find((r) => r.id === id) || null;
const agentList = (st) => Object.values(st.agents || {});
const crewOf = (st, roomId) => agentList(st).filter((a) => a.room === roomId);
const agentName = (st, id) => st.agents?.[id]?.name || id || '—';
const lanesOf = (st, roomId) => (st.station?.hallways || []).filter((hw) => hw.a === roomId || hw.b === roomId);
const usersOf = (st, objectId) => agentList(st).filter((a) => a.status === 'tool' && a.objectId === objectId);
const activeRuns = (st) => Object.values(st.runs || {}).filter((r) => r.outcome === null);
/** Provenance of a record, read from the run that produced it (state.runs[...].provider). */
const isScriptedRun = (st, runId) => Boolean(runId) && st.runs?.[runId]?.provider === 'scripted';
const scriptedRuns = (st) => Object.values(st.runs || {}).filter((r) => r.provider === 'scripted');
const SCRIPTED_TITLE = 'Produced by a scripted run (run.started provider = scripted): the decisions and text were scripted, no language model was called.';
const pendingApprovals = (st) => Object.values(st.approvals || {}).filter((a) => a.status === 'pending');
const roomOfAgent = (st, agentId) => roomById(st, st.agents?.[agentId]?.room);
const objectTypes = (room) => new Set((room?.objects || []).map((o) => o.type));

function findObject(st, objectId) {
  for (const room of st.station?.rooms || []) {
    for (const object of room.objects || []) if (object.id === objectId) return { room, object };
  }
  return null;
}

/** Mirrors sidecar/capability.js toolsForAgent: the same grants the runtime enforces. */
function grantsForAgent(st, agentId) {
  const station = st.station;
  const agent = station?.agents?.find((a) => a.id === agentId);
  const room = agent && station.rooms.find((r) => r.id === agent.room);
  if (!room) return [];
  const seen = new Map();
  for (const obj of room.objects || []) {
    for (const tool of OBJECT_GRANTS[obj.type] || []) if (!seen.has(tool)) seen.set(tool, obj.id);
  }
  const hasLane = station.hallways.some((hw) => hw.a === room.id || hw.b === room.id);
  const peers = station.agents.some((a) => a.room === room.id && a.id !== agentId);
  for (const tool of INTRINSIC_TOOLS) {
    if (tool === 'handoff' && !hasLane && !peers) continue;
    if (!seen.has(tool)) seen.set(tool, null);
  }
  return [...seen].map(([tool, objectId]) => ({ tool, objectId }));
}

function artifactsNewest(st, pred, limit) {
  const out = [];
  let total = 0;
  for (let i = st.artifactOrder.length - 1; i >= 0; i--) {
    const a = st.artifacts[st.artifactOrder[i]];
    if (!a || !pred(a)) continue;
    total += 1;
    if (out.length < limit) out.push(a);
  }
  return { list: out, total };
}

function feedClass(f, logLevels) {
  const t = f.text || '';
  switch (f.type) {
    case 'tool.denied':
    case 'estop':
      return 'error';
    case 'run.finished':
      return /\b(failed|aborted|budget_exceeded|max_turns|refused|interrupted)\b/.test(t) ? 'error' : 'run';
    case 'tool.result':
      return / error \(\d+ms\)$/.test(t) ? 'error' : 'tool';
    case 'task.status':
      return /^Task \S+ (failed|cancelled)/.test(t) ? 'error' : 'task';
    case 'connector.sync':
      return /sync failed/.test(t) ? 'error' : 'ledger';
    case 'agent.status':
      if (/→ error\b/.test(t)) return 'error';
      if (/→ awaiting_approval\b/.test(t)) return 'approval';
      return 'status';
    case 'approval.requested':
    case 'approval.resolved':
      return 'approval';
    case 'ledger.entry':
      return /\[agent_claim\]$/.test(t) ? 'claim' : 'ledger';
    case 'spend.recorded':
      return 'ledger';
    case 'handoff':
      return 'handoff';
    case 'artifact.created':
      return 'artifact';
    case 'log': {
      const lvl = logLevels.get(f.seq);
      return lvl === 'error' ? 'error' : lvl === 'warn' ? 'approval' : 'log';
    }
    case 'run.started':
    case 'run.step':
      return 'run';
    case 'tool.called':
      return 'tool';
    default:
      return 'misc';
  }
}

function receiptBadge(r) {
  if (!r || r.status === 'loading') return { cls: 'dim', text: 'READING…' };
  if (r.status !== 'done' || !r.json || typeof r.json !== 'object') return { cls: 'warn', text: 'UNREADABLE' };
  const j = r.json;
  const mode = String(j.mode || '').toLowerCase();
  if (mode === 'dry_run' || mode === 'dry-run' || j.dry_run === true || j.dryRun === true) return { cls: 'warn', text: 'DRY RUN' };
  if (mode.includes('etsy') || j.listingId || j.listing_id) return { cls: 'ok', text: 'ETSY DRAFT' };
  return { cls: 'dim', text: mode ? mode.toUpperCase() : 'MODE NOT STATED' };
}

// ---------------------------------------------------------------------------------------

export function createUI(root, client, world) {
  const S = () => client.state;
  const M = () => client.meta || {};
  const mq = window.matchMedia('(max-width: 900px)');
  const isMobile = () => mq.matches;
  const shell = document.getElementById('shell');
  const logLevels = new Map();
  const receipts = new Map();
  let receiptsVersion = 0;
  let frame = 0;
  let resnap = false;
  const modalStack = [];
  let modalSeq = 0;

  const store = {
    get(k) {
      try {
        return window.localStorage.getItem(`outpost.${k}`);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        window.localStorage.setItem(`outpost.${k}`, v);
      } catch {
        /* storage unavailable: per-viewer convenience only */
      }
    },
  };

  // ---- shared actions -----------------------------------------------------------------

  function open(selection, opts = {}) {
    panel.open(selection, opts);
  }

  /** keySuffix only disambiguates focus-restore keys when one agent appears many times. */
  function agentLink(id, keySuffix = '') {
    const a = S().agents[id];
    if (!a) return h('span', { class: 'mono', text: id || '—' });
    return h(
      'button',
      {
        type: 'button',
        class: 'link agent-link',
        k: `agent:${id}:${keySuffix}`,
        vars: { '--suit': a.palette?.suit },
        on: { click: () => open({ type: 'agent', id }) },
      },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      a.name,
    );
  }

  function roomLink(id) {
    const r = roomById(S(), id);
    return h(
      'button',
      { type: 'button', class: 'link room-link', k: `room:${id}`, vars: { '--accent': r?.color }, on: { click: () => open({ type: 'room', id }) } },
      r ? r.name : id,
    );
  }

  function statusPill(a) {
    return h('span', { class: `pill st-${a.status}` }, STATUS_LABEL[a.status] || String(a.status).toUpperCase(), a.tool ? ` · ${a.tool}` : '');
  }

  function provBadge(p) {
    if (p === 'connector') return h('span', { class: 'badge prov-connector', title: 'Fetched from a platform API (carries source.externalId). Counted.', text: 'VERIFIED' });
    if (p === 'manual') return h('span', { class: 'badge prov-manual', title: 'Typed in by the operator. Counted as manual provenance.', text: 'OPERATOR' });
    return h('span', { class: 'badge prov-claim', title: 'An agent said so. Displayed, never summed into counted totals.', text: 'CLAIM · NOT COUNTED' });
  }

  // ---- web taint (taint / taintSources on artifacts, approvals, runs, memory notes) ----------

  const TAINT_TITLE = 'Derived from web pages (web_search / web_fetch), directly or through a tainted input. Web content can carry injected instructions.';

  /** SCRIPTED marker for a record whose run was scripted (provenance per record, not per mode). */
  function scriptedMark(scripted) {
    return scripted ? h('span', { class: 'badge b-warn scripted-mark', title: SCRIPTED_TITLE, text: 'SCRIPTED' }) : null;
  }

  /** Small amber marker for lists; null when the record is clean. */
  function taintMark(rec, text = 'WEB') {
    return isWebTainted(rec) ? h('span', { class: 'taint-mark', title: TAINT_TITLE, text }) : null;
  }

  /** The recorded taint sources: artifact ids open the viewer; the rest are labelled. */
  function taintSources(sources, onArtifact) {
    const list = Array.isArray(sources) && sources.length ? sources : ['web'];
    return h(
      'span',
      { class: 'taint-sources' },
      list.map((src, i) => {
        const a = S().artifacts[src];
        let el;
        if (src === 'web') el = h('span', { text: 'web search / fetch' });
        else if (a) el = h('button', { type: 'button', class: 'link mono', title: `${a.kind} "${a.title}" by ${agentName(S(), a.agentId)}`, on: { click: () => onArtifact(src) } }, src);
        else if (src.startsWith('memory:')) el = h('span', { text: `memory note ${src.slice(7)}` });
        else if (S().runs[src]) el = h('span', { class: 'mono', text: `run ${src}` });
        else el = h('span', { class: 'mono', text: src });
        return [i ? ', ' : null, el];
      }),
    );
  }

  function setResult(el, kind, text) {
    el.className = `result r-${kind}`;
    el.textContent = text;
  }

  async function act(btn, out, fn, okText) {
    btn.disabled = true;
    setResult(out, 'busy', 'TRANSMITTING…');
    try {
      const res = await fn();
      setResult(out, 'ok', okText(res || {}));
    } catch (err) {
      setResult(out, 'error', `ERROR: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  function toast(kind, text) {
    const t = h('div', { class: `toast r-${kind}`, text });
    toasts.append(t);
    setTimeout(() => t.remove(), 6000);
  }

  function receiptInfo(id) {
    let r = receipts.get(id);
    if (!r) {
      r = { status: 'loading', json: null };
      receipts.set(id, r);
      fetch(client.artifactUrl(id))
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((text) => {
          try {
            r.json = JSON.parse(text);
            r.status = 'done';
          } catch {
            r.status = 'error';
          }
        })
        .catch(() => {
          r.status = 'error';
        })
        .finally(() => {
          receiptsVersion += 1;
          schedule();
        });
    }
    return r;
  }

  // ---- modal infrastructure -----------------------------------------------------------

  function focusables(node) {
    return [...node.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
      (el) => el.getClientRects().length > 0,
    );
  }

  function openModal({ build, wide = false, onClose }) {
    const opener = document.activeElement;
    const titleId = `modal-title-${++modalSeq}`;
    const backdrop = h('div', { class: 'modal-backdrop' });
    const dialog = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' });
    let closed = false;
    const entry = {
      dialog,
      close(value) {
        if (closed) return;
        closed = true;
        backdrop.remove();
        modalStack.splice(modalStack.indexOf(entry), 1);
        if (!modalStack.length && shell) shell.inert = false;
        if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
        if (onClose) onClose(value);
      },
    };
    add(dialog, [build(entry.close, titleId)]);
    backdrop.append(dialog);
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) entry.close();
    });
    dialog.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Tab') return;
      const f = focusables(dialog);
      if (!f.length) {
        ev.preventDefault();
        dialog.focus();
        return;
      }
      const first = f[0];
      const last = f[f.length - 1];
      if (ev.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    });
    document.body.append(backdrop);
    modalStack.push(entry);
    if (shell) shell.inert = true;
    const first = dialog.querySelector('[data-autofocus]') || focusables(dialog)[0];
    (first || dialog).focus({ preventScroll: true });
    return entry;
  }

  function confirmDialog({ title, body, confirmText, danger = false }) {
    return new Promise((resolve) => {
      openModal({
        onClose: (v) => resolve(v === true),
        build: (close, titleId) => [
          h('div', { class: 'modal-head' }, h('h2', { id: titleId, class: danger ? 't-danger' : '', text: title })),
          h('div', { class: 'modal-body' }, h('p', { class: 'confirm-text', text: body })),
          h(
            'div',
            { class: 'modal-actions' },
            h('button', { type: 'button', class: 'btn ghost', on: { click: () => close(false) } }, 'CANCEL'),
            h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, on: { click: () => close(true) } }, confirmText),
          ),
        ],
      });
    });
  }

  function openArtifact(id) {
    openModal({
      wide: true,
      build: (close, titleId) => {
        const st = S();
        const a = st.artifacts[id];
        if (!a) {
          return [
            h('div', { class: 'modal-head' }, h('h2', { id: titleId, text: 'UNKNOWN ARTIFACT' }), h('button', { type: 'button', class: 'btn ghost small', 'aria-label': 'Close', on: { click: () => close() } }, '✕ CLOSE')),
            h('div', { class: 'modal-body' }, empty(`No artifact.created event for ${id} in this projection.`)),
          ];
        }
        const task = a.taskId ? st.tasks[a.taskId] : null;
        const url = client.artifactUrl(a.artifactId);
        const content = h('div', { class: 'art-content' });
        if (a.kind === 'svg' || a.kind === 'image') {
          const img = h('img', { src: url, alt: a.title, class: 'art-img' });
          img.addEventListener('error', () => swap(content, empty('Could not load the artifact content.')));
          content.append(h('div', { class: 'art-img-frame' }, img));
        } else {
          const pre = h('pre', { class: 'art-pre', text: 'READING…' });
          content.append(pre);
          fetch(url)
            .then((res) => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.text();
            })
            .then((text) => {
              const cut = text.length > TEXT_LIMIT;
              const body = cut ? text.slice(0, TEXT_LIMIT) : text;
              const isJson = a.kind !== 'text' || /json/.test(a.mime || '');
              pre.textContent = (isJson && !cut ? prettyMaybeJson(body) : body) + (cut ? `\n\n… truncated at ${bytesFmt(TEXT_LIMIT)} of ${bytesFmt(text.length)}` : '');
            })
            .catch((err) => {
              pre.textContent = `Could not load the artifact content (${err.message}).`;
            });
        }
        const sha = String(a.sha256 || '');
        const tainted = isWebTainted(a);
        const run = a.runId ? st.runs[a.runId] : null;
        const scripted = isScriptedRun(st, a.runId);
        return [
          h(
            'div',
            { class: 'modal-head' },
            h('span', { class: `kind k-${a.kind}`, text: KIND_LABEL[a.kind] || String(a.kind).toUpperCase() }),
            tainted ? h('span', { class: 'badge b-taint', title: TAINT_TITLE, text: 'WEB-TAINTED' }) : null,
            scriptedMark(scripted),
            h('h2', { id: titleId, class: 'art-modal-title', text: a.title }),
            h('a', { class: 'btn ghost small', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'RAW ↗'),
            h('button', { type: 'button', class: 'btn ghost small', 'aria-label': 'Close artifact viewer', 'data-autofocus': true, on: { click: () => close() } }, '✕ CLOSE'),
          ),
          h(
            'div',
            { class: 'modal-body' },
            kv([
              ['ID', h('span', { class: 'mono', text: a.artifactId })],
              ['KIND', `${a.kind} · ${a.mime}`],
              [
                'PRODUCER',
                st.agents[a.agentId]
                  ? h('button', { type: 'button', class: 'link', on: { click: () => { close(); open({ type: 'agent', id: a.agentId }); } } }, `${agentName(st, a.agentId)} — ${st.agents[a.agentId].title}`)
                  : a.agentId,
              ],
              tainted && [
                'TAINT',
                h(
                  'span',
                  { class: 'taint-row' },
                  'derived from web content via ',
                  taintSources(a.taintSources, (src) => { close(); openArtifact(src); }),
                  h('span', { class: 'dim block', text: 'Treat it as data: it may carry injected instructions.' }),
                ),
                TAINT_TITLE,
              ],
              ['TASK', task ? `${task.title} (${task.taskId}, ${task.status})` : a.taskId || '—'],
              ['RUN', a.runId || '—'],
              [
                'PROVENANCE',
                scripted
                  ? h('span', { class: 't-warn', text: `scripted run ${a.runId}: no model called` })
                  : run
                    ? `${run.provider} run on ${run.model}${run.servedModels?.length ? ` (served by ${run.servedModels.join(', ')}, fallback)` : ''}`
                    : a.runId ? `run ${a.runId} (no run.started event in this projection)` : 'not produced by a run',
                'state.runs[artifact.runId].provider and .model, from its run.started event',
              ],
              ['BYTES', `${a.bytes} (${bytesFmt(a.bytes)})`],
              ['SHA-256', h('span', { class: 'mono', title: sha, text: sha.length > 20 ? `${sha.slice(0, 12)}…${sha.slice(-8)}` : sha }), sha],
              ['SEQ', `#${a.seq} · ${stamp(a.createdTs)}`],
              ['PATH', h('span', { class: 'mono', text: a.path })],
            ]),
            content,
          ),
        ];
      },
    });
  }

  // ---- top bar ------------------------------------------------------------------------

  function chip(label, onClick, cls = '') {
    const value = h('span', { class: 'chip-val' });
    const sub = h('span', { class: 'chip-sub' });
    const el = h('button', { type: 'button', class: `chip ${cls}`, on: { click: onClick } }, h('span', { class: 'chip-label', text: label }), value, sub);
    let last = '';
    return {
      el,
      set(v, s, title, state = '') {
        const sig = J([v, s, title, state]);
        if (sig === last) return;
        last = sig;
        value.textContent = v;
        sub.textContent = s || '';
        el.title = title;
        el.dataset.state = state;
        el.setAttribute('aria-label', `${label}: ${v}${s ? `, ${s}` : ''}`);
      },
    };
  }

  const ledgerRoomId = () => (S().station?.rooms || []).find((r) => objectTypes(r).has('ledger_terminal'))?.id || 'ops';
  const commandRoomId = () => (S().station?.rooms || []).find((r) => objectTypes(r).has('command_console'))?.id || 'bridge';

  /**
   * The provider badge. A configured key proves nothing: LIVE needs a run.step from an anthropic run
   * in the log, and an authentication failure on the newest decisive run is shown as such.
   */
  function providerBadge() {
    const m = M();
    if (m.provider !== 'anthropic') {
      return { cls: m.provider === 'scripted' ? 'warn' : 'dim', text: m.providerLabel || m.provider || 'PROVIDER UNKNOWN', title: `Provider as reported by the runtime: meta.provider = ${m.provider || 'unknown'}` };
    }
    const check = anthropicStatus(S());
    if (check.status === 'auth_failed') {
      return { cls: 'danger', text: 'ANTHROPIC API · LAST CALL FAILED: AUTH', title: `meta.provider = anthropic, but run ${check.runId} failed authentication: ${check.error}` };
    }
    if (check.status === 'verified') {
      return { cls: 'ok', text: 'LIVE · Anthropic API', title: `meta.provider = anthropic, and run ${check.runId} recorded a provider step (run.step), so the key works.` };
    }
    return { cls: 'warn', text: 'ANTHROPIC API · key set, not yet verified', title: 'meta.provider = anthropic because a key is configured; no anthropic run has recorded a provider step yet, so the key is unverified.' };
  }

  const topbar = (() => {
    const brand = live('div', { class: 'brand' }, () => J([S().station?.name, M().providerLabel, M().provider, M().provider === 'anthropic' && anthropicStatus(S())]), () => {
      const badge = providerBadge();
      return [
        h('span', { class: 'logo', 'aria-hidden': 'true', text: '▚▞' }),
        h('h1', { class: 'station-name', text: S().station?.name || 'NO STATION LOADED' }),
        h('span', { class: `badge provider ${badge.cls}`, title: badge.title, text: badge.text }),
      ];
    });
    const link = h('span', { class: 'link-ind', role: 'status' });
    const runs = chip('ACTIVE RUNS', () => open({ type: 'room', id: commandRoomId() }));
    const today = chip('SPEND TODAY (UTC)', () => open({ type: 'room', id: ledgerRoomId() }));
    const total = chip('SPEND TOTAL', () => open({ type: 'room', id: ledgerRoomId() }));
    const revenue = chip('VERIFIED REVENUE', () => open({ type: 'room', id: ledgerRoomId() }), 'chip-rev');
    const approvals = chip('APPROVALS', () => open({ type: 'approvals' }), 'chip-appr');
    const estop = h('button', { type: 'button', class: 'estop', on: { click: toggleEstop } });
    const el = h(
      'header',
      { id: 'topbar', class: 'topbar' },
      h('div', { class: 'brand-row' }, brand.el, link),
      h('div', { class: 'chips' }, runs.el, today.el, total.el, revenue.el, approvals.el, estop),
    );
    let estopSig = '';

    function updateLink() {
      const st = S();
      const state = client.link === 'live' ? 'live' : 'down';
      link.dataset.state = state;
      link.textContent = client.link === 'live' ? `● LIVE  SEQ #${st.seq}` : `○ ${String(client.link).toUpperCase()}  SEQ #${st.seq}`;
      link.title =
        client.link === 'live'
          ? `Event stream connected. Showing the projection of events 1..${st.seq}.`
          : `Event stream down (${client.linkDetail || 'retrying'}). The view is frozen at seq #${st.seq}.`;
    }

    function update() {
      const st = S();
      updateLink();
      brand.update();
      // Link down: these are the last values the stream delivered, not the station now.
      const stale = client.link !== 'live';
      const staleNote = stale ? ' LAST KNOWN VALUE: the event stream is down, so this may be out of date.' : '';
      const ar = activeRuns(st);
      runs.set(
        String(ar.length),
        `${ar.length ? ar.map((r) => agentName(st, r.agentId)).join(' ') : 'none'}${stale ? ' · last known' : ''}`,
        `ACTIVE RUNS = runs with a run.started event and no run.finished yet (state.runs where outcome is null).${ar.length ? ` Now: ${ar.map((r) => `${r.runId} (${r.agentId})`).join(', ')}.` : ''}${staleNote}`,
        stale ? 'stale' : ar.length ? 'on' : '',
      );
      const day = utcDay();
      const cap = st.station?.budgets?.stationDailyUsd;
      const spentToday = st.spend.byDay[day] || 0;
      today.set(
        usd(spentToday),
        typeof cap === 'number' ? `of ${usd(cap)} cap` : day,
        `SPEND TODAY (UTC) = run.step costUsd (priced by sidecar/pricing.js) + spend.recorded usd, for events timestamped ${day} (UTC day; it rolls over at 00:00 UTC).${typeof cap === 'number' ? ` Cap = station.budgets.stationDailyUsd from the layout.` : ''}${staleNote}`,
        stale ? 'stale' : typeof cap === 'number' && spentToday >= cap ? 'danger' : '',
      );
      const scriptedSteps = st.spend.scriptedSteps || 0;
      total.set(
        usd(st.spend.totalUsd),
        scriptedSteps && scriptedSteps === st.spend.steps ? plural(scriptedSteps, 'scripted step') : `${plural(st.spend.steps, 'step')}${scriptedSteps ? ` · ${scriptedSteps} scr.` : ''}`,
        `SPEND TOTAL = every run.step costUsd + spend.recorded usd in the event log (LLM + image). Reported separately; not subtracted from NET COUNTED.${scriptedSteps ? ` ${scriptedSteps} of the ${st.spend.steps} steps are from scripted runs: no model was called and they cost $0.` : ''}${staleNote}`,
        stale ? 'stale' : '',
      );
      const t = st.ledger.totals;
      const cov = evidenceCoverage(t);
      const caveat = coverageCaveat(t);
      const other = Object.entries(st.ledger.unconverted || {});
      revenue.set(
        cents(t.verifiedRevenueCents),
        `EVIDENCE ${caveat ? 'n/a' : pct(cov)}${other.length ? ` +${other.map(([cur]) => cur).join('/')}` : ''}`,
        `VERIFIED REVENUE = ledger.entry revenue minus refunds with provenance 'connector' (fetched from a platform API, each carrying source.externalId), in USD. EVIDENCE = verified ÷ (verified + operator-entered) counted revenue, each floored at zero, rounded down; '—' when nothing is counted${caveat ? `; now n/a because ${caveat}` : ''}. It covers revenue only: fees, costs and LLM/image spend are outside it. Agent claims are never included.${other.length ? ` Entries in ${other.map(([cur, u]) => `${cur} (${u.entries})`).join(', ')} are not converted and are excluded from every total.` : ''}${staleNote}`,
        stale ? 'stale' : cov === null && !caveat ? '' : 'gold',
      );
      const pend = pendingApprovals(st).length;
      approvals.set(
        String(pend),
        `${pend ? 'pending' : 'none pending'}${stale ? ' · last known' : ''}`,
        `APPROVALS = approval.requested events with no approval.resolved yet (status 'pending').${stale ? ' Deciding is disabled until the event stream is back.' : ''}${staleNote}`,
        stale ? 'stale' : pend ? 'warn' : '',
      );
      const sig = J([st.estop]);
      if (sig !== estopSig) {
        estopSig = sig;
        estop.textContent = st.estop ? 'E-STOP ENGAGED · RELEASE' : 'E-STOP';
        estop.dataset.engaged = String(st.estop);
        estop.setAttribute('aria-pressed', String(st.estop));
        estop.title = st.estop
          ? 'E-STOP is engaged (last estop event: engaged=true). Click to release; asks for confirmation, then POST /api/estop {engaged:false}.'
          : 'Emergency stop: aborts every run and blocks new ones. Asks for confirmation, then POST /api/estop {engaged:true}.';
      }
    }
    return { el, update, updateLink };
  })();

  async function toggleEstop() {
    const engaged = !S().estop;
    const ok = await confirmDialog({
      title: engaged ? 'ENGAGE E-STOP?' : 'RELEASE E-STOP?',
      body: engaged
        ? 'Every running agent run is aborted and no new run starts until you release the stop.'
        : 'Releasing lets the dispatcher start queued tasks again.',
      confirmText: engaged ? 'ENGAGE E-STOP' : 'RELEASE',
      danger: engaged,
    });
    if (!ok) return;
    try {
      await client.post('/api/estop', { engaged });
      toast('ok', engaged ? 'E-STOP sent. The station shows it when the estop event arrives.' : 'Release sent. The station shows it when the estop event arrives.');
    } catch (err) {
      toast('error', `E-STOP request failed: ${err.message}`);
    }
  }

  const banners = live(
    'div',
    { class: 'banners' },
    () => J([M().provider, M().storeFailed, S().estop, client.link === 'reconnecting', client.linkDetail, M().provider !== 'scripted' && scriptedRuns(S()).length]),
    () => [
      M().storeFailed
        ? h(
            'div',
            { class: 'banner danger', role: 'alert' },
            h('strong', { text: 'RECORDING STOPPED' }),
            ` — the event log failed a write (${M().storeFailed}). Nothing new is recorded or started, so this view shows the last recorded state; runs it shows as running are not. Free the disk and restart the sidecar.`,
          )
        : null,
      M().provider === 'scripted'
        ? h(
            'div',
            { class: 'banner warn', role: 'note' },
            h('strong', { text: 'SCRIPTED DEMO' }),
            ' — tools, files, events and approvals are real; agent decisions are scripted, no model is called. Set ANTHROPIC_API_KEY to run live agents.',
          )
        : scriptedRuns(S()).length
          ? h(
              'div',
              { class: 'banner warn', role: 'note' },
              h('strong', { text: 'SCRIPTED RECORDS IN THIS LOG' }),
              ` — this log contains ${plural(scriptedRuns(S()).length, 'scripted run')}: records marked SCRIPTED were produced without a model.`,
            )
          : null,
      S().estop ? h('div', { class: 'banner danger', role: 'alert' }, h('strong', { text: 'E-STOP ENGAGED' }), ' — all runs halted; no new run starts until released.') : null,
      client.link === 'reconnecting'
        ? h('div', { class: 'banner danger', role: 'alert' }, h('strong', { text: 'LINK LOST' }), ` — reconnecting to the event stream (${client.linkDetail || 'retrying'}). The view is frozen at seq #${S().seq} and may be stale.`)
        : null,
    ],
  );

  // ---- views --------------------------------------------------------------------------

  function makeView(title, opts = {}) {
    const view = {
      title,
      kind: opts.kind || 'x',
      focusId: opts.focusId || null,
      accent: opts.accent || null,
      blocks: [],
      el: h('div', { class: `view view-${opts.kind || 'x'}`, vars: { '--accent': opts.accent } }),
      live(tag, props, sig, render) {
        const b = live(tag, props, sig, render);
        view.blocks.push(b);
        return b.el;
      },
      add(...kids) {
        add(view.el, kids);
        return view;
      },
    };
    return view;
  }

  function notFoundView(what) {
    return makeView('NOT FOUND', { kind: 'missing' }).add(empty(`${what} is not in the current projection.`));
  }

  function artItem(a) {
    return h(
      'li',
      { class: 'art-item' },
      h(
        'button',
        { type: 'button', class: 'art-btn', k: `art:${a.artifactId}`, on: { click: () => openArtifact(a.artifactId) } },
        h('span', { class: `kind k-${a.kind}`, text: KIND_LABEL[a.kind] || String(a.kind).toUpperCase() }),
        h('span', { class: 'art-title', text: a.title }),
        h('span', { class: 'art-meta' }, scriptedMark(isScriptedRun(S(), a.runId)), taintMark(a), `${agentName(S(), a.agentId)} · ${bytesFmt(a.bytes)} · #${a.seq} ${hms(a.createdTs)}`),
      ),
    );
  }

  function artBlock(view, pred, limit, emptyText) {
    return view.live(
      'div',
      { class: 'art-block' },
      () => {
        const r = artifactsNewest(S(), pred, limit);
        return J([r.total, r.list.map((a) => a.artifactId)]);
      },
      () => {
        const r = artifactsNewest(S(), pred, limit);
        if (!r.list.length) return empty(emptyText);
        return [h('ul', { class: 'list arts' }, r.list.map(artItem)), r.total > r.list.length ? h('p', { class: 'more', text: `+${r.total - r.list.length} older` }) : null];
      },
    );
  }

  function galleryBlock(view, pred, limit, emptyText) {
    return view.live(
      'div',
      { class: 'gallery-block' },
      () => {
        const r = artifactsNewest(S(), pred, limit);
        return J([r.total, r.list.map((a) => a.artifactId)]);
      },
      () => {
        const r = artifactsNewest(S(), pred, limit);
        if (!r.list.length) return empty(emptyText);
        return [
          h(
            'div',
            { class: 'gallery' },
            r.list.map((a) =>
              h(
                'button',
                { type: 'button', class: 'thumb', k: `thumb:${a.artifactId}`, title: `${a.title} — open viewer`, on: { click: () => openArtifact(a.artifactId) } },
                h('span', { class: 'thumb-frame' }, h('img', { src: client.artifactUrl(a.artifactId), alt: a.title, loading: 'lazy', decoding: 'async' })),
                h('span', { class: 'thumb-cap', text: a.title }),
                h('span', { class: 'thumb-meta' }, scriptedMark(isScriptedRun(S(), a.runId)), taintMark(a), `${KIND_LABEL[a.kind] || a.kind} · ${agentName(S(), a.agentId)} · #${a.seq}`),
              ),
            ),
          ),
          r.total > r.list.length ? h('p', { class: 'more', text: `+${r.total - r.list.length} older` }) : null,
        ];
      },
    );
  }

  const inRoom = (roomId) => (a) => S().agents[a.agentId]?.room === roomId;

  // STATION overview: the keyboard/touch path to everything on the canvas.
  function viewStation() {
    const v = makeView('STATION', { kind: 'station' });
    v.add(
      v.live(
        'div',
        { class: 'view-head' },
        () => J([S().station?.name, S().station?.budgets, S().station?.rooms?.length, S().station?.agents?.length]),
        () => {
          const st = S();
          const b = st.station?.budgets || {};
          return [
            h('div', { class: 'kicker', text: 'STATION TERMINAL' }),
            h('p', { class: 'purpose', text: 'Rooms are capability-scoped teams, placed objects are tool grants, hallways are handoff lanes. Everything here is folded from the event log.' }),
            kv([
              ['ROOMS', String(st.station?.rooms?.length ?? 0)],
              ['CREW', String(st.station?.agents?.length ?? 0)],
              typeof b.stationDailyUsd === 'number' ? ['DAILY CAP', usd(b.stationDailyUsd), 'station.budgets.stationDailyUsd'] : null,
              typeof b.maxConcurrentRuns === 'number' ? ['MAX CONCURRENT', `${b.maxConcurrentRuns} runs`, 'station.budgets.maxConcurrentRuns'] : null,
            ]),
          ];
        },
      ),
      sec(
        'ROOMS',
        'select to open its terminal',
        v.live(
          'ul',
          { class: 'list rooms' },
          () => J([(S().station?.rooms || []).map((r) => r.id), agentList(S()).map((a) => [a.id, a.room, a.status])]),
          () =>
            (S().station?.rooms || []).map((r) => {
              const crew = crewOf(S(), r.id);
              return h(
                'li',
                {},
                h(
                  'button',
                  { type: 'button', class: 'room-btn', k: `room:${r.id}`, vars: { '--accent': r.color }, on: { click: () => open({ type: 'room', id: r.id }) } },
                  h('span', { class: 'swatch', 'aria-hidden': 'true' }),
                  h('span', { class: 'room-name', text: r.name }),
                  h('span', { class: 'room-crew', text: crew.length ? crew.map((a) => `${a.name} ${STATUS_LABEL[a.status] || a.status}`).join(' · ') : 'no crew' }),
                ),
              );
            }),
        ),
      ),
      sec(
        'CREW',
        null,
        v.live(
          'ul',
          { class: 'list crew' },
          () => J(agentList(S()).map((a) => [a.id, a.status, a.tool, a.detail])),
          () =>
            agentList(S()).map((a) =>
              h('li', { class: 'crew-item compact' }, h('div', { class: 'row' }, agentLink(a.id), h('span', { class: 'dim', text: a.title }), statusPill(a)), a.detail ? h('div', { class: 'sub', text: a.detail }) : null),
            ),
        ),
      ),
      sec(
        'APPROVALS',
        null,
        v.live(
          'div',
          {},
          () => J(pendingApprovals(S()).map((a) => a.approvalId)),
          () => {
            const p = pendingApprovals(S());
            return [
              p.length ? h('ul', { class: 'list' }, p.map((ap) => h('li', { class: 'appr-line' }, h('span', { class: 'pill st-awaiting_approval', text: ap.tool }), ' ', taintMark(ap, 'WEB-DERIVED'), `${agentName(S(), ap.agentId)}: ${ap.summary}`))) : empty('No approval is pending.'),
              h('button', { type: 'button', class: 'btn small', k: 'open-approvals', on: { click: () => open({ type: 'approvals' }) } }, 'OPEN APPROVALS'),
            ];
          },
        ),
      ),
      sec('RECENT ARTIFACTS', null, artBlock(v, () => true, 6, 'No artifact has been produced yet.')),
    );
    return v;
  }

  function viewRoom(id) {
    const room0 = roomById(S(), id);
    if (!room0) return notFoundView(`Room "${id}"`);
    const R = () => roomById(S(), id) || room0;
    const v = makeView(room0.name.toUpperCase(), { kind: 'room', accent: room0.color, focusId: id });
    v.add(h('div', { class: 'view-head' }, h('div', { class: 'kicker', text: `ROOM TERMINAL // ${id}` }), h('p', { class: 'purpose', text: room0.purpose })));

    v.add(
      sec(
        'CREW',
        null,
        v.live(
          'ul',
          { class: 'list crew' },
          () => J(crewOf(S(), id).map((a) => [a.id, a.status, a.tool, a.taskId, a.detail, a.taskId && S().tasks[a.taskId]?.status])),
          () => {
            const crew = crewOf(S(), id);
            if (!crew.length) return empty('No agent is assigned to this room.');
            return crew.map((a) => {
              const task = a.taskId ? S().tasks[a.taskId] : null;
              return h(
                'li',
                { class: 'crew-item' },
                h('div', { class: 'row' }, agentLink(a.id), h('span', { class: 'dim', text: a.title }), statusPill(a)),
                h(
                  'div',
                  { class: 'sub' },
                  task
                    ? ['TASK ', h('span', { class: 'mono dim', text: task.taskId }), ' ', h('span', { class: 'strong', text: task.title }), ' ', h('span', { class: `tstat ts-${task.status}`, text: task.status.toUpperCase() })]
                    : a.taskId
                      ? ['TASK ', h('span', { class: 'mono dim', text: a.taskId }), ' · no task.created event seen']
                      : 'no current task',
                ),
                a.detail ? h('div', { class: 'sub detail', text: a.detail }) : null,
              );
            });
          },
        ),
      ),
    );

    v.add(
      sec(
        'CAPABILITIES',
        'tool grants · enforced by the runtime',
        v.live(
          'ul',
          { class: 'list caps' },
          () => J([R().objects, (R().objects || []).map((o) => usersOf(S(), o.id).map((a) => a.id)), lanesOf(S(), id).length, crewOf(S(), id).length]),
          () => {
            const r = R();
            const items = (r.objects || []).map((o) => {
              const users = usersOf(S(), o.id);
              const tools = OBJECT_GRANTS[o.type];
              return h(
                'li',
                { class: `cap${users.length ? ' in-use' : ''}` },
                h(
                  'div',
                  { class: 'row' },
                  h('button', { type: 'button', class: 'link', k: `obj:${o.id}`, on: { click: () => open({ type: 'object', id: o.id }) } }, o.id),
                  h('span', { class: 'dim', text: o.type }),
                  users.length ? h('span', { class: 'pill st-tool', text: `IN USE · ${users.map((u) => `${u.name} ${u.tool || ''}`.trim()).join(', ')}` }) : null,
                ),
                h('div', { class: 'tools' }, tools ? tools.map((t) => h('code', { class: 'tool', text: t })) : h('span', { class: 't-danger', text: 'unknown object type: grants nothing' })),
              );
            });
            if (lanesOf(S(), id).length || crewOf(S(), id).length > 1) {
              items.push(
                h(
                  'li',
                  { class: 'cap intrinsic' },
                  h('div', { class: 'row' }, h('span', { class: 'dim', text: 'intrinsic (every crew member)' })),
                  h('div', { class: 'tools' }, INTRINSIC_TOOLS.map((t) => h('code', { class: 'tool', text: t }))),
                  h('div', { class: 'sub', text: 'handoff: to a peer in this room or across exactly one hallway lane' }),
                ),
              );
            }
            return items.length ? items : empty('No object is placed here, so this room grants no tools.');
          },
        ),
      ),
    );

    v.add(
      sec(
        'LANES',
        'hallways = authorised handoff lanes',
        v.live(
          'ul',
          { class: 'list lanes' },
          () => J([lanesOf(S(), id).map((hw) => hw.id), S().handoffs.length, S().handoffs[S().handoffs.length - 1]?.seq]),
          () => {
            const st = S();
            const lanes = lanesOf(st, id);
            if (!lanes.length) return empty('No hallway connects this room: it cannot hand off to other rooms.');
            return lanes.map((hw) => {
              const other = hw.a === id ? hw.b : hw.a;
              const used = st.handoffs.filter((x) => (x.route || []).includes(hw.id));
              const last = used[used.length - 1];
              return h(
                'li',
                { class: 'lane' },
                h('div', { class: 'row' }, h('span', { class: 'mono dim', text: hw.id }), h('span', { 'aria-hidden': 'true', text: '⇄' }), roomLink(other)),
                h(
                  'div',
                  { class: 'sub' },
                  used.length
                    ? `${used.length} of the last ${st.handoffs.length} recorded handoffs used this lane · last #${last.seq} at ${hms(last.ts)}`
                    : `not used by any of the last ${st.handoffs.length} recorded handoffs`,
                ),
              );
            });
          },
        ),
      ),
    );

    const types = objectTypes(room0);
    if (types.has('command_console')) commandSection(v, id);
    if (types.has('listing_composer') || types.has('publish_gate')) productionSection(v, id);
    if (types.has('packager') || types.has('delivery_gate')) outputSection(v, id);
    if (types.has('research_terminal')) researchSection(v, id);
    if (types.has('ledger_terminal') || types.has('connector_dock')) ledgerSection(v);
    return v;
  }

  function commandSection(v, roomId) {
    const commander = crewOf(S(), roomId)[0];
    const goalTa = h('textarea', { id: 'goal-input', class: 'input', rows: '3', maxlength: '4000', placeholder: 'Describe an outcome. The commander decomposes it into delegated tasks.' });
    const goalOut = h('div', { class: 'result', role: 'status', 'aria-live': 'polite' });
    const goalBtn = h('button', { type: 'submit', class: 'btn primary' }, 'TRANSMIT GOAL');
    const goalForm = h(
      'form',
      {
        class: 'form',
        on: {
          submit: (ev) => {
            ev.preventDefault();
            const goal = goalTa.value.trim();
            if (!goal) {
              setResult(goalOut, 'error', 'Write a goal first.');
              goalTa.focus();
              return;
            }
            act(goalBtn, goalOut, () => client.post('/api/goals', { goal }), (res) => {
              goalTa.value = '';
              return `ACCEPTED${res.taskId ? ` · task ${res.taskId}` : ''}. It appears on the board when its task.created event arrives.`;
            });
          },
        },
      },
      h('label', { for: 'goal-input', class: 'label', text: `GOAL → ${commander ? `${commander.name} (${commander.title})` : 'COMMANDER'}` }),
      goalTa,
      h('div', { class: 'actions' }, goalBtn),
      goalOut,
    );

    let recipe = RECIPES[0];
    const paramsByRecipe = Object.fromEntries(RECIPES.map((r) => [r, '{}']));
    const paramsTa = h('textarea', { id: 'recipe-params', class: 'input mono', rows: '3', spellcheck: 'false', value: '{}', 'aria-describedby': 'recipe-help' });
    const launchBtn = h('button', { type: 'submit', class: 'btn primary' }, `LAUNCH ${recipe}`);
    const recipeOut = h('div', { class: 'result', role: 'status', 'aria-live': 'polite' });
    const recipeBtns = RECIPES.map((name) =>
      h(
        'button',
        {
          type: 'button',
          class: 'btn toggle small',
          'aria-pressed': String(name === recipe),
          on: {
            click: () => {
              paramsByRecipe[recipe] = paramsTa.value;
              recipe = name;
              paramsTa.value = paramsByRecipe[name];
              for (const b of recipeBtns) b.setAttribute('aria-pressed', String(b.textContent === name));
              launchBtn.textContent = `LAUNCH ${name}`;
            },
          },
        },
        name,
      ),
    );
    const recipeForm = h(
      'form',
      {
        class: 'form',
        on: {
          submit: (ev) => {
            ev.preventDefault();
            let params;
            try {
              params = JSON.parse(paramsTa.value.trim() || '{}');
              if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params must be a JSON object');
            } catch (err) {
              setResult(recipeOut, 'error', `PARAMS: ${err.message}`);
              paramsTa.focus();
              return;
            }
            const name = recipe;
            act(launchBtn, recipeOut, () => client.post(`/api/recipes/${encodeURIComponent(name)}`, { params }), (res) =>
              `${name} ACCEPTED${res.recipeRunId ? ` · ${res.recipeRunId}` : ''}${Array.isArray(res.taskIds) ? ` · ${res.taskIds.length} tasks` : ''}. Tasks appear as their events arrive.`,
            );
          },
        },
      },
      h('div', { class: 'label', id: 'recipe-label', text: 'RECIPE' }),
      h('div', { class: 'toggles', role: 'group', 'aria-labelledby': 'recipe-label' }, recipeBtns),
      h('label', { for: 'recipe-params', class: 'label', text: 'PARAMS (JSON object)' }),
      paramsTa,
      h('p', { class: 'help', id: 'recipe-help', text: '{} runs the recipe with its own defaults (sidecar/recipes.js).' }),
      h('div', { class: 'actions' }, launchBtn),
      recipeOut,
    );

    v.add(
      sec('COMMAND', 'operator → commander', goalForm),
      sec('RECIPE LAUNCHER', null, recipeForm),
      sec(
        'RECIPE RUNS',
        null,
        v.live(
          'ul',
          { class: 'list' },
          () => J([Object.values(S().recipes).map((r) => [r.recipeRunId, r.taskIds.map((t) => S().tasks[t]?.status)]), Object.keys(S().runs).length]),
          () => {
            const st = S();
            const runs = Object.values(st.recipes).reverse().slice(0, 6);
            if (!runs.length) return empty('No recipe has been started.');
            return runs.map((r) => {
              const statuses = r.taskIds.map((t) => st.tasks[t]?.status || 'unknown');
              const done = statuses.filter((s) => s === 'done').length;
              const bad = statuses.filter((s) => s === 'failed' || s === 'cancelled').length;
              const scripted = Object.values(st.tasks).some((t) => t.recipeRunId === r.recipeRunId && t.runIds.some((id) => isScriptedRun(st, id)));
              return h(
                'li',
                { class: 'recipe-run' },
                h('div', { class: 'row' }, h('span', { class: 'strong', text: r.title }), scriptedMark(scripted)),
                h('div', { class: 'sub', text: `${r.recipe} · ${r.recipeRunId} · started ${hms(r.startedTs)} · ${done}/${statuses.length} tasks done${bad ? ` · ${bad} failed/cancelled` : ''}` }),
              );
            });
          },
        ),
      ),
      sec(
        'TASK BOARD',
        'grouped by status',
        v.live(
          'div',
          { class: 'board' },
          () => J(S().taskOrder.map((tid) => {
            const t = S().tasks[tid];
            return t ? [tid, t.status, t.runIds.length, t.summary, t.reason] : tid;
          })),
          () => {
            const st = S();
            if (!st.taskOrder.length) return empty('No task has been created.');
            const newest = [...st.taskOrder].reverse().map((tid) => st.tasks[tid]).filter(Boolean);
            return TASK_GROUPS.map(([status, label]) => {
              const all = newest.filter((t) => t.status === status);
              if (!all.length) return null;
              const shown = all.slice(0, GROUP_LIMIT);
              return h(
                'div',
                { class: `task-group tg-${status}` },
                h('h4', { class: 'group-title' }, h('span', { text: label }), h('span', { class: 'count', text: String(all.length) })),
                h('ul', { class: 'list tasks' }, shown.map(taskItem)),
                all.length > shown.length ? h('p', { class: 'more', text: `+${all.length - shown.length} older ${label.toLowerCase()}` }) : null,
              );
            });
          },
        ),
      ),
    );
  }

  function taskItem(t) {
    const scripted = t.runIds.some((id) => isScriptedRun(S(), id));
    return h(
      'li',
      { class: `task ts-${t.status}` },
      h('div', { class: 'row' }, h('span', { class: 'mono dim', text: t.taskId }), h('span', { class: 'strong', text: t.title }), t.kind === 'review' ? h('span', { class: 'tag', text: 'REVIEW' }) : null, scriptedMark(scripted)),
      h(
        'div',
        { class: 'sub' },
        '→ ',
        agentLink(t.assignee, `t-${t.taskId}`),
        ` · runs ${t.runIds.length}`,
        t.createdBy ? ` · by ${t.createdBy}` : '',
        t.dependsOn?.length ? ` · after ${t.dependsOn.join(', ')}` : '',
      ),
      t.summary || t.reason ? h('div', { class: 'sub sum', text: t.summary || t.reason }) : null,
      TERMINAL_TASK.has(t.status)
        ? null
        : h('button', { type: 'button', class: 'btn small ghost-danger', k: `cancel:${t.taskId}`, on: { click: () => cancelTask(t.taskId, t.title) } }, 'CANCEL'),
    );
  }

  async function cancelTask(taskId, title) {
    const ok = await confirmDialog({ title: 'CANCEL TASK?', body: `Cancel ${taskId} "${title}"? A running run is aborted; dependants are cancelled by the dispatcher.`, confirmText: 'CANCEL TASK', danger: true });
    if (!ok) return;
    try {
      await client.post(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {});
      toast('ok', `Cancel sent for ${taskId}. The board updates when task.status arrives.`);
    } catch (err) {
      toast('error', `Cancel failed: ${err.message}`);
    }
  }

  function productionSection(v, roomId) {
    v.add(
      h('h3', { class: 'terminal-title', text: 'PRODUCTION TERMINAL' }),
      sec('DESIGN GALLERY', 'svg + image artifacts from this room', galleryBlock(v, (a) => (a.kind === 'svg' || a.kind === 'image') && inRoom(roomId)(a), 12, 'No design has been rendered yet.')),
      sec('LISTING DRAFTS', null, artBlock(v, (a) => a.kind === 'listing_draft', 10, 'No listing draft yet.')),
      sec(
        'PUBLISH RECEIPTS',
        'mode read from each receipt',
        v.live(
          'div',
          {},
          () => J([artifactsNewest(S(), (a) => a.kind === 'publish_receipt', 10).list.map((a) => a.artifactId), receiptsVersion]),
          () => {
            const r = artifactsNewest(S(), (a) => a.kind === 'publish_receipt', 10);
            if (!r.list.length) return empty('Nothing has been published. Publishing pauses for operator approval.');
            return [
              h(
                'ul',
                { class: 'list arts' },
                r.list.map((a) => {
                  const badge = receiptBadge(receiptInfo(a.artifactId));
                  const li = artItem(a);
                  li.querySelector('.art-btn').append(h('span', { class: `badge b-${badge.cls}`, text: badge.text }));
                  return li;
                }),
              ),
              r.total > r.list.length ? h('p', { class: 'more', text: `+${r.total - r.list.length} older` }) : null,
            ];
          },
        ),
      ),
    );
  }

  function outputSection(v, roomId) {
    v.add(
      h('h3', { class: 'terminal-title', text: 'OUTPUT TERMINAL' }),
      sec('THUMBNAILS', 'svg + image artifacts from this room', galleryBlock(v, (a) => (a.kind === 'svg' || a.kind === 'image') && inRoom(roomId)(a), 12, 'No thumbnail has been drafted yet.')),
      sec('PACKAGES', 'manifests with per-file sha256', artBlock(v, (a) => a.kind === 'package', 10, 'No package has been built.')),
      sec('DELIVERY HAND-OFF SHEETS', 'manual delivery: the operator sends these', artBlock(v, (a) => a.kind === 'delivery', 10, 'No delivery sheet yet. Delivery pauses for operator approval.')),
    );
  }

  function researchSection(v, roomId) {
    v.add(
      h('h3', { class: 'terminal-title', text: 'RESEARCH LAB' }),
      sec('BRIEFS', 'json + text artifacts from this room', artBlock(v, (a) => (a.kind === 'json' || a.kind === 'text') && inRoom(roomId)(a), 12, 'No brief has been written yet.')),
      sec(
        'MEMORY',
        'namespaces from memory.written events',
        v.live(
          'div',
          {},
          () => J(S().memory),
          () => {
            const mem = S().memory;
            const names = Object.keys(mem).sort((a, b) => (a === roomId ? -1 : b === roomId ? 1 : a.localeCompare(b)));
            if (!names.length) return empty('No memory has been written.');
            return names.map((ns) => {
              const keys = Object.entries(mem[ns].keys || {});
              const room = roomById(S(), ns);
              return h(
                'div',
                { class: `mem-ns${ns === roomId ? ' own' : ''}` },
                h('div', { class: 'row' }, h('span', { class: 'strong mono', text: ns }), room ? h('span', { class: 'dim', text: room.name }) : null, h('span', { class: 'dim', text: `${plural(mem[ns].writes, 'write')}` })),
                keys.length
                  ? h('ul', { class: 'list mem-keys' }, keys.map(([k, b]) => h(
                    'li',
                    {},
                    h('code', { class: 'tool', text: k }),
                    h('span', { class: 'dim', text: ` ${bytesFmt(b)} ` }),
                    taintMark(Object.hasOwn(mem[ns].tainted || {}, k) ? { taint: 'web' } : null),
                  )))
                  : empty('no keys'),
              );
            });
          },
        ),
      ),
    );
  }

  function bars(rows, nameFn) {
    const max = Math.max(0, ...rows.map(([, n]) => n));
    if (!rows.length) return empty('Nothing recorded.');
    return h(
      'table',
      { class: 'tbl bars' },
      h('tbody', {}, rows.map(([k, n]) =>
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, nameFn ? nameFn(k) : k),
          h('td', { class: 'bar-cell' }, h('span', { class: 'bar', vars: { '--w': `${max > 0 && n > 0 ? Math.max(1, Math.round((n / max) * 100)) : 0}%` }, 'aria-hidden': 'true' })),
          h('td', { class: 'num', text: usd(n) }),
        ),
      )),
    );
  }

  function ledgerSection(v) {
    const L = () => S().ledger;
    v.add(
      h('h3', { class: 'terminal-title', text: 'LEDGER TERMINAL' }),
      v.live(
        'div',
        { class: 'figures' },
        () => J(L().totals),
        () => {
          const t = L().totals;
          return [
            h(
              'div',
              { class: 'figure f-verified', title: "Sum of ledger.entry revenue − refunds with provenance 'connector'." },
              h('div', { class: 'fig-label', text: 'VERIFIED' }),
              h('div', { class: 'fig-val', text: cents(t.verifiedRevenueCents) }),
              h('div', { class: 'fig-sub', text: `connector · ${plural(t.verifiedOrders, 'order')} · counted` }),
            ),
            h(
              'div',
              { class: 'figure f-manual', title: "Sum of ledger.entry revenue − refunds with provenance 'manual'." },
              h('div', { class: 'fig-label', text: 'OPERATOR-ENTERED' }),
              h('div', { class: 'fig-val', text: cents(t.operatorRevenueCents) }),
              h('div', { class: 'fig-sub', text: `manual · ${plural(t.operatorOrders, 'order')} · counted` }),
            ),
            h(
              'div',
              { class: 'figure f-claim', title: "Sum of ledger.entry revenue − refunds with provenance 'agent_claim'. Never added to any counted total." },
              h('div', { class: 'fig-label', text: 'AGENT CLAIMS' }),
              h('div', { class: 'fig-val' }, h('s', { text: cents(t.claimedRevenueCents) })),
              h('div', { class: 'fig-sub', text: 'not counted' }),
            ),
          ];
        },
      ),
      v.live(
        'div',
        { class: 'net' },
        () => J([L().totals, L().unconverted]),
        () => {
          const t = L().totals;
          const cov = evidenceCoverage(t);
          const caveat = coverageCaveat(t);
          const other = Object.entries(L().unconverted || {});
          return [
            kv([
              ['FEES', negCents(t.feesCents), "ledger.entry kind 'fee' (connector + manual)"],
              ['COSTS', negCents(t.costCents), "ledger.entry kind 'cost' (connector + manual)"],
              ['NET COUNTED', h('span', { class: 'strong big', text: cents(netCents(t)) }), 'verified + operator-entered − fees − costs. Agent claims and LLM/image spend are excluded.'],
              [
                'EVIDENCE COVERAGE',
                caveat
                  ? h('span', { class: 't-warn', text: `n/a: ${caveat}` })
                  : h('span', {}, pct(cov), h('span', { class: 'dim', text: cov === null ? ' no counted revenue yet' : ' of counted revenue' })),
                "verified ÷ (verified + operator-entered) revenue, each net of its refunds and floored at zero, rounded down; '—' when no revenue is counted, n/a when a provenance's refunds exceed its revenue. Fees and costs are not part of it.",
              ],
            ]),
            other.length
              ? h(
                  'p',
                  { class: 'unconverted t-warn', title: 'Nothing converts currencies, so these entries are listed in ENTRIES in their own currency and left out of every total above.' },
                  `${other.map(([cur, u]) => `${plural(u.entries, `${cur} entry`).replace(/entrys$/, 'entries')}`).join(', ')} not converted, excluded from totals (all figures above are USD): `,
                  other.map(([cur, u], i) => `${i ? '; ' : ''}${cur} verified ${money(u.verifiedRevenueCents, cur)}, operator ${money(u.operatorRevenueCents, cur)}, fees ${money(u.feesCents, cur)}`).join(''),
                )
              : null,
          ];
        },
      ),
      h(
        'ul',
        { class: 'help ledger-honesty' },
        h('li', { text: 'EVIDENCE COVERAGE covers revenue only: the share of counted revenue fetched by a connector. Fees and costs are not covered by it.' }),
        h('li', { text: 'NET COUNTED excludes LLM and image spend. That spend is real money and is shown separately under LLM / IMAGE SPEND below.' }),
        h('li', { text: 'NET COUNTED = verified + operator-entered − fees − costs. Agent claims are shown, never summed.' }),
      ),
      sec(
        'BY STREAM',
        null,
        v.live(
          'div',
          { class: 'tbl-wrap' },
          () => J(L().byStream),
          () => {
            const rows = Object.entries(L().byStream);
            if (!rows.length) return empty('No ledger entry yet.');
            return h(
              'table',
              { class: 'tbl streams' },
              h('thead', {}, h('tr', {}, ['STREAM', 'VERIFIED', 'OPERATOR', 'NET'].map((c, i) => h('th', { scope: 'col', class: i ? 'num' : '', text: c })))),
              h(
                'tbody',
                {},
                rows.map(([name, t]) => [
                  h(
                    'tr',
                    { class: 'entry' },
                    h('th', { scope: 'row', text: name }),
                    h('td', { class: 'num', text: cents(t.verifiedRevenueCents) }),
                    h('td', { class: 'num', text: cents(t.operatorRevenueCents) }),
                    h('td', { class: 'num strong', text: cents(netCents(t)) }),
                  ),
                  h(
                    'tr',
                    { class: 'entry-sub' },
                    h('td', { colspan: '4' }, `fees+costs ${negCents(t.feesCents + t.costCents)} · agent claims `, h('s', { class: 'claim-s', text: cents(t.claimedRevenueCents) }), ' not counted'),
                  ),
                ]),
              ),
            );
          },
        ),
      ),
      sec(
        'LLM / IMAGE SPEND',
        'run.step + spend.recorded',
        v.live(
          'div',
          {},
          () => J([S().spend, utcDay()]),
          () => {
            const sp = S().spend;
            const day = utcDay();
            return [
              kv([
                ['TOTAL', usd(sp.totalUsd)],
                ['TODAY (UTC)', usd(sp.byDay[day] || 0), `spend.byDay["${day}"]`],
                ['PROVIDER STEPS', String(sp.steps)],
              ]),
              h('h4', { class: 'group-title', text: 'BY AGENT' }),
              bars(Object.entries(sp.byAgent).sort((a, b) => b[1] - a[1]), (k) => agentName(S(), k)),
              h('h4', { class: 'group-title', text: 'BY MODEL' }),
              bars(Object.entries(sp.byModel).sort((a, b) => b[1] - a[1])),
            ];
          },
        ),
      ),
      sec(
        'ENTRIES',
        'newest first',
        v.live(
          'div',
          { class: 'tbl-wrap' },
          () => J([L().entryOrder.length, L().entryOrder[L().entryOrder.length - 1]]),
          () => {
            const Ld = L();
            const ids = Ld.entryOrder.slice(-60).reverse();
            if (!ids.length) return empty('No ledger entry yet.');
            const rows = [];
            for (const eid of ids) {
              const e = Ld.entries[eid];
              if (!e) continue;
              const negative = e.kind !== 'revenue';
              const currency = entryCurrency(e);
              const amt = `${negative ? '−' : ''}${money(e.amountCents, currency)}`;
              const src = e.source || {};
              const srcText = src.connector && src.externalId ? `${src.connector}:${src.externalId}` : src.url || src.note || '—';
              rows.push(
                h(
                  'tr',
                  { class: `p-${e.provenance}` },
                  h(
                    'td',
                    {},
                    h('div', { class: 'entry-line' }, h('span', { class: 'mono', text: ymd(e.occurredAt) }), ` · ${e.stream} · ${e.kind}`),
                    h(
                      'div',
                      { class: 'entry-meta' },
                      provBadge(e.provenance),
                      currency === 'USD' ? null : h('span', { class: 'badge b-warn', title: 'Not converted: excluded from every USD total.', text: `${currency} · NOT IN TOTALS` }),
                      h('span', { class: 'mono dim', text: ` #${e.seq} ${srcText}` }),
                      e.memo ? h('span', { class: 'dim', text: ` · ${e.memo}` }) : null,
                    ),
                  ),
                  h('td', { class: 'num amount' }, e.provenance === 'agent_claim' ? h('s', { text: amt }) : amt),
                ),
              );
            }
            return [
              h('table', { class: 'tbl entries' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col', title: 'date · stream · kind, then provenance · #seq source · memo', text: 'ENTRY' }), h('th', { scope: 'col', class: 'num', text: 'AMOUNT' }))), h('tbody', {}, rows)),
              Ld.entryOrder.length > ids.length ? h('p', { class: 'more', text: `+${Ld.entryOrder.length - ids.length} older entries` }) : null,
            ];
          },
        ),
      ),
    );

    // Connectors
    const syncOut = h('div', { class: 'result', role: 'status', 'aria-live': 'polite' });
    const syncBtn = h('button', { type: 'button', class: 'btn' }, 'SYNC ETSY');
    syncBtn.addEventListener('click', () =>
      act(syncBtn, syncOut, () => client.post('/api/connectors/etsy/sync', {}), (res) =>
        `SYNC ACCEPTED${res.receipts ? ` · receipts fetched ${res.receipts.fetched}, new ${res.receipts.newEntries}` : typeof res.fetched === 'number' ? ` · fetched ${res.fetched}, new ${res.newEntries ?? 0}` : ''}${res.fees ? ` · fee lines fetched ${res.fees.fetched}, new ${res.fees.newEntries}` : ''}. Entries appear as ledger.entry events arrive.`,
      ),
    );
    v.add(
      sec(
        'CONNECTORS',
        null,
        v.live(
          'div',
          {},
          () => J([M().connectors?.etsy, S().connectors.etsy]),
          () => {
            const configured = !!M().connectors?.etsy?.configured;
            const c = S().connectors.etsy;
            return kv([
              ['ETSY', configured ? h('span', { class: 'badge b-ok', text: 'CONFIGURED' }) : h('span', { class: 'badge b-warn', text: 'NOT CONFIGURED' }), 'meta.connectors.etsy.configured'],
              configured ? null : ['SETUP', M().connectors?.etsy?.setup || 'see the sidecar banner for the Etsy settings', 'meta.connectors.etsy.setup (sidecar/connectors/etsy.js ETSY_SETUP_HINT)'],
              ['LAST SYNC', c ? `${stamp(c.lastSyncTs)} · ${c.ok ? 'OK' : 'FAILED'}` : 'never (no connector.sync event)'],
              c
                ? [
                    'RESULT',
                    c.receipts || c.fees
                      ? [
                          c.receipts ? `receipts fetched ${c.receipts.fetched} · new ${c.receipts.newEntries}` : null,
                          c.fees ? `fee lines fetched ${c.fees.fetched} · new ${c.fees.newEntries}` : null,
                          plural(c.syncs, 'sync') + ' total',
                        ].filter(Boolean).join(' · ')
                      : `fetched ${c.fetched} · new ${c.newEntries} · ${plural(c.syncs, 'sync')} total`,
                  ]
                : null,
              c && c.error ? ['ERROR', h('span', { class: 't-danger', text: c.error })] : null,
            ]);
          },
        ),
        h('div', { class: 'actions' }, syncBtn),
        syncOut,
      ),
    );

    // Manual entry
    const kindSel = h('select', { id: 'man-kind', class: 'input', required: true }, ['revenue', 'refund', 'fee', 'cost'].map((k) => h('option', { value: k, text: k })));
    const amount = h('input', { id: 'man-amount', class: 'input', type: 'number', min: '0.01', step: '0.01', inputmode: 'decimal', required: true, placeholder: '0.00' });
    const stream = h('input', { id: 'man-stream', class: 'input', type: 'text', list: 'man-streams', required: true, maxlength: '40', autocomplete: 'off' });
    const memo = h('input', { id: 'man-memo', class: 'input', type: 'text', maxlength: '200', autocomplete: 'off' });
    const streams = v.live('datalist', { id: 'man-streams' }, () => J(Object.keys(L().byStream)), () =>
      [...new Set(['etsy', 'fiverr', 'assets', ...Object.keys(L().byStream)])].map((s) => h('option', { value: s })),
    );
    const manOut = h('div', { class: 'result', role: 'status', 'aria-live': 'polite' });
    const manBtn = h('button', { type: 'submit', class: 'btn primary' }, 'RECORD ENTRY');
    const form = h(
      'form',
      {
        class: 'form grid-form',
        on: {
          submit: (ev) => {
            ev.preventDefault();
            const amountUsd = Math.round(Number(amount.value) * 100) / 100;
            if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
              setResult(manOut, 'error', 'Amount must be a positive number of dollars.');
              amount.focus();
              return;
            }
            const s = stream.value.trim();
            if (!s) {
              setResult(manOut, 'error', 'Stream is required (e.g. etsy, fiverr).');
              stream.focus();
              return;
            }
            const body = { kind: kindSel.value, amount_usd: amountUsd, stream: s, memo: memo.value.trim() };
            act(manBtn, manOut, () => client.post('/api/ledger/manual', body), () => {
              amount.value = '';
              memo.value = '';
              return `SENT ${body.kind} ${usd(amountUsd)} → ${s}. It is counted when its ledger.entry event arrives.`;
            });
          },
        },
      },
      h(
        'fieldset',
        {},
        h('legend', { text: 'MANUAL ENTRY — operator-entered, counted as manual provenance' }),
        h('label', { for: 'man-kind', class: 'label', text: 'KIND' }),
        kindSel,
        h('label', { for: 'man-amount', class: 'label', text: 'AMOUNT (USD)' }),
        amount,
        h('label', { for: 'man-stream', class: 'label', text: 'STREAM' }),
        stream,
        streams,
        h('label', { for: 'man-memo', class: 'label', text: 'MEMO' }),
        memo,
        h('div', { class: 'actions span' }, manBtn),
        manOut,
      ),
    );
    v.add(sec('OPERATOR ENTRY', null, form));
  }

  function viewAgent(id) {
    const a0 = S().agents[id];
    if (!a0) return notFoundView(`Agent "${id}"`);
    const A = () => S().agents[id] || a0;
    const v = makeView(a0.name, { kind: 'agent', accent: a0.palette?.suit, focusId: id });
    v.add(
      v.live(
        'div',
        { class: 'view-head dossier-head' },
        () => J([A().name, A().title, A().role]),
        () => [
          h('div', { class: 'kicker', text: String(A().title || 'CREW').toUpperCase() }),
          h('div', { class: 'dossier-name' }, h('span', { class: 'dot big', 'aria-hidden': 'true', vars: { '--suit': A().palette?.suit } }), A().name),
          A().role ? h('p', { class: 'purpose', text: A().role }) : null,
        ],
      ),
      v.live(
        'div',
        {},
        () => J([A().status, A().detail, A().tool, A().taskId, A().taskId && S().tasks[A().taskId]?.status, A().runs, A().spentUsd, M().provider, M().modelOverride, A().room, A().model]),
        () => {
          const a = A();
          const st = S();
          const room = roomOfAgent(st, id);
          const task = a.taskId ? st.tasks[a.taskId] : null;
          const scripted = M().provider === 'scripted';
          const override = !scripted && M().modelOverride ? M().modelOverride : null;
          const myRuns = Object.values(st.runs).filter((r) => r.agentId === id);
          const lastRun = myRuns.at(-1);
          const scriptedCount = myRuns.filter((r) => r.provider === 'scripted').length;
          // MODEL = what this agent's next run uses (from meta); LAST RUN = what its runs really used.
          const modelRow = scripted
            ? ['MODEL', h('span', {}, 'scripted', h('span', { class: 'dim', text: ` · configured ${a.model || '—'}, not called` })), 'meta.provider is scripted: decisions come from sidecar/providers/scripts.js']
            : override
              ? ['MODEL', h('span', {}, override, h('span', { class: 'dim', text: ` · OUTPOST_MODEL override; layout says ${a.model || '—'}` })), 'meta.modelOverride (OUTPOST_MODEL) applies to every agent']
              : ['MODEL', a.model || '—', 'agent.model from the station layout (no OUTPOST_MODEL override)'];
          return kv([
            modelRow,
            lastRun
              ? [
                  'LAST RUN',
                  h(
                    'span',
                    {},
                    `${lastRun.model} [${lastRun.provider}]`,
                    lastRun.servedModels?.length ? h('span', { class: 't-warn', text: ` · served by ${lastRun.servedModels.join(', ')} (fallback)` }) : null,
                    scriptedCount ? h('span', { class: 'dim block', text: `${scriptedCount} of ${plural(myRuns.length, 'run')} scripted: no model called` }) : null,
                  ),
                  `run.started of ${lastRun.runId}: the model and provider that run really used`,
                ]
              : null,
            ['EFFORT', a.effort || '—'],
            ['ROOM', room ? h('span', {}, roomLink(room.id), h('span', { class: 'dim block', text: room.purpose })) : a.room || '—'],
            ['STATUS', h('span', {}, statusPill(a), a.detail ? h('span', { class: 'dim block', text: a.detail }) : null), `last agent.status at seq #${a.lastSeq || '—'}`],
            ['TASK', task ? `${task.title} (${task.taskId}, ${task.status})` : a.taskId ? `${a.taskId} · no task.created event seen` : 'none'],
            ['RUNS', String(a.runs), 'count of run.started events for this agent'],
            ['SPEND', usd(a.spentUsd), 'run.step costUsd + spend.recorded usd attributed to this agent'],
            ['BUDGET / RUN', typeof a.runBudgetUsd === 'number' ? usd(a.runBudgetUsd) : '—', 'runBudgetUsd from the station layout'],
            ['MAX TURNS', a.maxTurns != null ? String(a.maxTurns) : '—'],
          ]);
        },
      ),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn small', on: { click: () => focusWorld(id) } }, 'LOCATE ON STATION')),
      sec(
        'RECENT RUNS',
        'last 8',
        v.live(
          'div',
          { class: 'tbl-wrap' },
          () => J(Object.values(S().runs).filter((r) => r.agentId === id).slice(-8).map((r) => [r.runId, r.outcome, r.turns, r.costUsd, r.summary, r.error, r.servedModels])),
          () => {
            const runs = Object.values(S().runs).filter((r) => r.agentId === id).slice(-8).reverse();
            if (!runs.length) return empty('No run.started event for this agent yet.');
            const rows = [];
            for (const r of runs) {
              rows.push(
                h(
                  'tr',
                  {},
                  h('td', { class: 'mono', text: r.runId }),
                  h('td', {}, h('span', { class: `pill out-${r.outcome || 'running'}`, text: (r.outcome || 'running').toUpperCase() }), r.provider === 'scripted' ? [' ', scriptedMark(true)] : null),
                  h('td', { class: 'num', text: String(r.turns) }),
                  h('td', { class: 'num', text: usd(r.costUsd) }),
                ),
              );
              const note = r.error || r.summary || r.lastText;
              const served = r.servedModels?.length ? ` · served by ${r.servedModels.join(', ')} (fallback)` : '';
              if (note || served) rows.push(h('tr', { class: 'entry-sub' }, h('td', { colspan: '4', text: `${r.model}${r.provider ? ` [${r.provider}]` : ''}${served}${note ? ` · ${clip(note, 220)}` : ''}` })));
            }
            return h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['RUN', 'OUTCOME', 'TURNS', 'COST'].map((c, i) => h('th', { scope: 'col', class: i >= 2 ? 'num' : '', text: c })))), h('tbody', {}, rows));
          },
        ),
      ),
      sec('RECENT ARTIFACTS', null, artBlock(v, (a) => a.agentId === id, 8, 'This agent has not produced an artifact.')),
      sec(
        'PENDING APPROVALS',
        null,
        v.live(
          'div',
          {},
          () => J(pendingApprovals(S()).filter((ap) => ap.agentId === id).map((ap) => ap.approvalId)),
          () => {
            const p = pendingApprovals(S()).filter((ap) => ap.agentId === id);
            if (!p.length) return empty('None.');
            return [h('ul', { class: 'list' }, p.map((ap) => h('li', { class: 'appr-line' }, h('span', { class: 'pill st-awaiting_approval', text: ap.tool }), ' ', taintMark(ap, 'WEB-DERIVED'), ap.summary))), h('button', { type: 'button', class: 'btn small', on: { click: () => open({ type: 'approvals' }) } }, 'OPEN APPROVALS')];
          },
        ),
      ),
      sec(
        'TOOL GRANTS',
        'from room objects · enforced by the runtime',
        v.live(
          'ul',
          { class: 'list grants' },
          () => J(grantsForAgent(S(), id)),
          () => {
            const g = grantsForAgent(S(), id);
            if (!g.length) return empty('No tools granted.');
            return g.map(({ tool, objectId }) =>
              h('li', { class: 'grant-row' }, h('code', { class: 'tool', text: tool }), h('span', { class: 'dim', text: objectId ? ` ← ${objectId}` : ' ← intrinsic' })),
            );
          },
        ),
      ),
    );
    return v;
  }

  function viewObject(id) {
    const found = findObject(S(), id);
    if (!found) return notFoundView(`Object "${id}"`);
    const { room, object } = found;
    const v = makeView(object.id.toUpperCase(), { kind: 'object', accent: room.color, focusId: id });
    const tools = OBJECT_GRANTS[object.type];
    v.add(
      h('div', { class: 'view-head' }, h('div', { class: 'kicker', text: `OBJECT // ${object.type}` }), h('p', { class: 'purpose' }, 'Placed in ', roomLink(room.id), ` at tile ${J(object.at)}. Every crew member of that room is granted these tools; the runtime re-checks each call.`)),
      sec('GRANTS', 'enforced by the runtime', tools ? h('div', { class: 'tools' }, tools.map((t) => h('code', { class: 'tool', text: t }))) : empty('Unknown object type: grants nothing.')),
      sec(
        'IN USE',
        "agents whose status is 'tool' at this object",
        v.live(
          'div',
          {},
          () => J(usersOf(S(), id).map((a) => [a.id, a.tool, a.detail])),
          () => {
            const users = usersOf(S(), id);
            if (!users.length) return empty('Not in use: no agent status names this object.');
            return h('ul', { class: 'list crew' }, users.map((a) => h('li', { class: 'crew-item' }, h('div', { class: 'row' }, agentLink(a.id), statusPill(a)), a.detail ? h('div', { class: 'sub', text: a.detail }) : null)));
          },
        ),
      ),
    );
    return v;
  }

  function viewApprovals() {
    const v = makeView('APPROVALS', { kind: 'approvals' });
    v.add(h('div', { class: 'view-head' }, h('div', { class: 'kicker', text: 'APPROVALS DRAWER' }), h('p', { class: 'purpose', text: 'Sensitive tools (publish, deliver) pause their run until you decide. A grant lets the tool run; what it sends, if anything, is stated on each card.' })));

    // Keyed so a note being typed survives unrelated events.
    const list = h('div', { class: 'approvals' });
    const cards = new Map();
    const emptyEl = empty('No approval is pending.');
    const pendingBlock = {
      update() {
        const pend = pendingApprovals(S());
        const ids = new Set(pend.map((p) => p.approvalId));
        for (const [aid, card] of cards) {
          if (!ids.has(aid)) {
            card.remove();
            cards.delete(aid);
          }
        }
        for (const ap of pend) if (!cards.has(ap.approvalId)) cards.set(ap.approvalId, approvalCard(ap));
        // Deciding needs a live event stream: a stale card may already be resolved or expired.
        for (const card of cards.values()) card.syncLink?.();
        const order = pend.map((p) => cards.get(p.approvalId));
        if (!order.length) {
          if (list.firstChild !== emptyEl || list.childNodes.length !== 1) list.replaceChildren(emptyEl);
          return;
        }
        if (emptyEl.isConnected) emptyEl.remove();
        let ref = list.firstChild;
        for (const card of order) {
          if (card === ref) ref = ref.nextSibling;
          else list.insertBefore(card, ref);
        }
      },
    };
    v.blocks.push(pendingBlock);

    const resolved = v.live(
      'div',
      {},
      () => J(Object.values(S().approvals).filter((a) => a.status !== 'pending').map((a) => [a.approvalId, a.status])),
      () => {
        const done = Object.values(S().approvals).filter((a) => a.status !== 'pending').reverse();
        if (!done.length) return empty('Nothing resolved yet.');
        return h(
          'ul',
          { class: 'list' },
          done.map((ap) =>
            h(
              'li',
              { class: 'appr-line' },
              h('span', { class: `pill ap-${ap.status}`, text: ap.status.toUpperCase() }),
              ' ',
              taintMark(ap, 'WEB-DERIVED'),
              `${agentName(S(), ap.agentId)} · ${ap.tool} · ${ap.summary}`,
              h('span', { class: 'dim block', text: `requested ${stamp(ap.requestedTs)} · resolved ${stamp(ap.resolvedTs)}${ap.note ? ` · note: ${ap.note}` : ''}` }),
            ),
          ),
        );
      },
    );
    const resolvedCount = v.live('span', { class: 'count' }, () => String(Object.values(S().approvals).filter((a) => a.status !== 'pending').length), () => String(Object.values(S().approvals).filter((a) => a.status !== 'pending').length));
    v.add(sec('PENDING', null, list), h('details', { class: 'resolved' }, h('summary', {}, 'RESOLVED ', resolvedCount), resolved));
    return v;
  }

  function approvalCard(ap) {
    const st = S();
    const noteId = `note-${ap.approvalId}`;
    const note = h('input', { id: noteId, class: 'input', type: 'text', maxlength: '500', autocomplete: 'off', placeholder: 'optional note to the agent' });
    const out = h('div', { class: 'result', role: 'status', 'aria-live': 'polite' });
    const grant = h('button', { type: 'button', class: 'btn grant' }, 'GRANT');
    const deny = h('button', { type: 'button', class: 'btn deny' }, 'DENY');
    let busy = false;
    let sent = false;
    const syncLink = () => {
      const down = client.link !== 'live';
      grant.disabled = deny.disabled = busy || sent || down;
      const title = down ? 'Event stream down: reconnect before deciding (this request may already be resolved or expired).' : '';
      grant.title = deny.title = title;
    };
    const decide = async (decision) => {
      busy = true;
      syncLink();
      setResult(out, 'busy', 'TRANSMITTING…');
      try {
        await client.post(`/api/approvals/${encodeURIComponent(ap.approvalId)}`, { decision, note: note.value.trim() || undefined });
        sent = true;
        setResult(out, 'ok', `${decision.toUpperCase()} sent. Waiting for the approval.resolved event.`);
      } catch (err) {
        setResult(out, 'error', `ERROR: ${err.message}`);
      } finally {
        busy = false;
        syncLink();
      }
    };
    syncLink();
    grant.addEventListener('click', () => decide('granted'));
    deny.addEventListener('click', () => decide('denied'));
    const tainted = isWebTainted(ap);
    const card = h(
      'article',
      { class: `approval${tainted ? ' tainted' : ''}`, 'aria-label': `Approval ${ap.approvalId}${tainted ? ', derived from web content' : ''}` },
      h('div', { class: 'row' }, agentLink(ap.agentId, `ap-${ap.approvalId}`), h('code', { class: 'tool', text: ap.tool }), h('span', { class: 'dim', text: `requested ${hms(ap.requestedTs)}` })),
      tainted
        ? h(
          'div',
          { class: 'taint-banner', role: 'note', title: TAINT_TITLE },
          h('strong', { text: 'DERIVED FROM WEB CONTENT — review for injected instructions' }),
          h('span', { class: 'taint-why' }, 'The requesting run used web content or a web-derived input (', taintSources(ap.taintSources, openArtifact), '). Check that the request matches what you asked for.'),
        )
        : null,
      h('p', { class: 'appr-summary', text: ap.summary }),
      h('pre', { class: 'appr-input', text: prettyMaybeJson(ap.input) }),
      h('div', { class: 'sub mono dim', text: `${ap.approvalId} · run ${ap.runId} · task ${ap.taskId}${st.tasks[ap.taskId] ? ` (${st.tasks[ap.taskId].title})` : ''}` }),
      h('label', { for: noteId, class: 'label', text: 'NOTE' }),
      note,
      h('div', { class: 'actions' }, grant, deny),
      out,
    );
    card.syncLink = syncLink;
    return card;
  }

  const VIEWS = { station: viewStation, room: viewRoom, agent: viewAgent, object: viewObject, approvals: viewApprovals };

  function focusWorld(id) {
    if (!id || !world || typeof world.focus !== 'function') return;
    try {
      world.focus(id);
    } catch (err) {
      console.error('world.focus failed', err);
    }
  }

  // ---- panel --------------------------------------------------------------------------

  const panel = (() => {
    const handleTitle = h('span', { class: 'handle-title' });
    const handle = h(
      'button',
      { type: 'button', class: 'sheet-handle', 'aria-expanded': 'false', 'aria-controls': 'panel-main' },
      h('span', { class: 'handle-icon', 'aria-hidden': 'true', text: '▲' }),
      h('span', { class: 'handle-label', text: 'TERMINAL' }),
      handleTitle,
    );
    const back = h('button', { type: 'button', class: 'btn ghost small', on: { click: () => open({ type: 'station' }) } }, '◂ STATION');
    const title = h('h2', { class: 'panel-title', id: 'panel-title' });
    const body = h('div', { class: 'panel-body', id: 'panel-body', tabindex: '-1' });
    // Narrow screens: the sheet bar (toggle + back) replaces the panel head, so the sheet
    // spends one row on chrome instead of two.
    const backSheet = h('button', { type: 'button', class: 'btn ghost small sheet-back', on: { click: () => open({ type: 'station' }) } }, '◂ STATION');
    const sheetBar = h('div', { class: 'sheet-bar' }, handle, backSheet);
    const main = h('div', { class: 'panel-main', id: 'panel-main' }, h('div', { class: 'panel-head' }, back, title), body);
    const el = h('aside', { id: 'panel', class: 'panel', 'aria-labelledby': 'panel-title' }, sheetBar, main);
    let current = null;
    let sheetOpen = false;

    function setSheet(on) {
      sheetOpen = on;
      el.classList.toggle('open', on);
      handle.setAttribute('aria-expanded', String(on));
      handle.querySelector('.handle-icon').textContent = on ? '▼' : '▲';
    }
    handle.addEventListener('click', () => setSheet(!sheetOpen));

    function normalize(sel) {
      if (!sel || typeof sel !== 'object' || !VIEWS[sel.type]) return { type: 'station' };
      return { type: sel.type, id: sel.id == null ? undefined : String(sel.id) };
    }

    function openSel(selection, { fromWorld = false, quiet = false } = {}) {
      if (selection && selection.type === 'artifact') {
        openArtifact(String(selection.id));
        return;
      }
      const sel = normalize(selection);
      const hadFocus = el.contains(document.activeElement);
      const view = VIEWS[sel.type](sel.id);
      current = { sel, view };
      for (const b of view.blocks) b.update(true);
      body.replaceChildren(view.el);
      body.scrollTop = 0;
      title.textContent = view.title;
      handleTitle.textContent = `· ${view.title}`;
      el.style.setProperty('--accent', view.accent || '');
      el.dataset.view = sel.type;
      el.dataset.id = sel.id || '';
      back.hidden = sel.type === 'station';
      backSheet.hidden = sel.type === 'station';
      store.set('view', J(sel));
      if (!quiet) setSheet(true);
      if (!fromWorld && view.focusId) focusWorld(view.focusId);
      if (hadFocus || document.activeElement === document.body) body.focus({ preventScroll: true });
    }

    function update() {
      if (current) for (const b of current.view.blocks) b.update();
    }
    function reopen() {
      if (current) openSel(current.sel, { fromWorld: true, quiet: true });
    }
    return {
      el,
      open: openSel,
      update,
      reopen,
      setSheet,
      get sheetOpen() {
        return sheetOpen;
      },
    };
  })();

  // ---- event feed ---------------------------------------------------------------------

  const feed = (() => {
    const toggle = h('button', { type: 'button', class: 'feed-toggle', 'aria-controls': 'feed-list' });
    const meta = h('span', { class: 'feed-meta' });
    const ticker = h('div', { class: 'ticker', 'aria-hidden': 'true' });
    const list = h('ol', { class: 'feed-list', id: 'feed-list', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Event feed, newest first' });
    const el = h('section', { id: 'feed', class: 'feed', 'aria-label': 'Event feed' }, h('div', { class: 'feed-head' }, toggle, meta, ticker), list);
    const rows = new Map();
    let maxSeen = 0;
    let desktopCollapsed = store.get('feedCollapsed') === '1';
    let mobileOpen = false;

    function syncToggle() {
      const mobile = isMobile();
      const expanded = mobile ? mobileOpen : !desktopCollapsed;
      el.classList.toggle('collapsed', !expanded);
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.textContent = `${expanded ? '▾' : '▸'} EVENT FEED`;
    }
    toggle.addEventListener('click', () => {
      if (isMobile()) mobileOpen = !mobileOpen;
      else {
        desktopCollapsed = !desktopCollapsed;
        store.set('feedCollapsed', desktopCollapsed ? '1' : '0');
      }
      syncToggle();
    });
    mq.addEventListener('change', syncToggle);
    syncToggle();

    function row(f, flash) {
      return h(
        'li',
        { class: `fe t-${feedClass(f, logLevels)}${flash ? ' flash' : ''}` },
        h('span', { class: 'fe-seq', text: `#${f.seq}` }),
        h('time', { class: 'fe-time', datetime: f.ts, text: hms(f.ts) }),
        h('span', { class: 'fe-text', text: f.text }),
      );
    }

    function update(reset = false) {
      const st = S();
      const entries = st.feed.slice(-FEED_SHOW).reverse();
      if (reset) {
        rows.clear();
        list.replaceChildren();
      }
      const initial = maxSeen === 0 || reset;
      const wanted = new Set(entries.map((f) => f.seq));
      for (const [seq, li] of rows) {
        if (!wanted.has(seq)) {
          li.remove();
          rows.delete(seq);
        }
      }
      let ref = list.firstChild;
      for (const f of entries) {
        let li = rows.get(f.seq);
        if (!li) {
          li = row(f, !initial && f.seq > maxSeen);
          rows.set(f.seq, li);
        }
        if (li === ref) ref = ref.nextSibling;
        else list.insertBefore(li, ref);
      }
      const newest = entries[0];
      if (newest) maxSeen = Math.max(maxSeen, newest.seq);
      meta.textContent = `newest first · ${entries.length} of ${st.feed.length} retained · seq #${st.seq}`;
      ticker.textContent = newest ? `#${newest.seq} ${hms(newest.ts)} ${newest.text}` : 'no events yet';
      ticker.className = `ticker t-${newest ? feedClass(newest, logLevels) : 'misc'}`;
    }
    return { el, update };
  })();

  const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });

  // ---- mount + reactivity ---------------------------------------------------------------

  root.replaceChildren(topbar.el, banners.el, panel.el, feed.el, toasts);

  function flush() {
    frame = 0;
    if (resnap) {
      resnap = false;
      feed.update(true);
      panel.reopen();
    } else {
      feed.update();
      panel.update();
    }
    topbar.update();
    banners.update();
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(flush);
  }

  // "Today" is the UTC day: re-render once when it rolls over, so an idle station does not keep
  // showing yesterday's spend (or yesterday's cap warning). A date boundary, not a ticking counter.
  let midnightTimer = 0;
  function armMidnight() {
    clearTimeout(midnightTimer);
    const d = new Date();
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 50;
    midnightTimer = setTimeout(() => {
      schedule();
      armMidnight();
    }, Math.max(1000, next - d.getTime()));
  }
  armMidnight();

  client.subscribe((e) => {
    if (e === null) resnap = true;
    else if (e.type === 'log' && e.payload) {
      logLevels.set(e.seq, e.payload.level);
      if (logLevels.size > 400) logLevels.delete(logLevels.keys().next().value);
    }
    schedule();
  });
  if (typeof client.onLink === 'function') {
    client.onLink(() => {
      topbar.updateLink();
      schedule();
    });
  }
  if (world && typeof world.onSelect === 'function') {
    world.onSelect((sel) => {
      if (sel && sel.type && sel.id != null) open(sel, { fromWorld: true });
    });
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (modalStack.length) {
      ev.preventDefault();
      modalStack[modalStack.length - 1].close();
    } else if (isMobile() && panel.sheetOpen) {
      ev.preventDefault();
      panel.setSheet(false);
    }
  });

  // Restore this viewer's last terminal (per-browser convenience only).
  let initial = { type: 'station' };
  try {
    const saved = JSON.parse(store.get('view') || 'null');
    if (saved && VIEWS[saved.type]) initial = saved;
  } catch {
    /* ignore */
  }
  panel.open(initial, { fromWorld: true, quiet: true });
  feed.update(true);
  topbar.update();
  banners.update();

  return {
    open(selection) {
      panel.open(selection);
    },
    openArtifact,
  };
}
