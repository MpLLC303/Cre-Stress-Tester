// HTTP surface of the sidecar: the station UI (static files), the projection (snapshot + SSE
// event stream), artifact bytes, and the operator's commands.
//
// The server binds to loopback and trusts nothing about the browser it talks to: a Host
// allow-list defeats DNS rebinding, and every POST must carry `x-outpost-client: 1` (a
// non-simple header, so a foreign page triggers a CORS preflight this server never approves)
// and, when the browser sends an Origin, an Origin that matches the Host.

import { createServer as createHttpServer } from 'node:http';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCall } from './capability.js';
import { readArtifact } from './artifacts.js';
import { newId } from './ids.js';
import { RECIPES } from './recipes.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_ROOTS = { frontend: join(ROOT, 'frontend'), shared: join(ROOT, 'shared') };
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const MAX_BODY_BYTES = 1024 * 1024;
const PING_MS = 15_000;
// A client that stops reading is dropped once this much is queued for it; its EventSource
// reconnects with ?since=<last seq> and replays from the log, so nothing is lost.
const MAX_SSE_QUEUE_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const APP_CSP = "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const ARTIFACT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
const LEDGER_KINDS = ['revenue', 'refund', 'fee', 'cost'];
const MAX_MANUAL_USD = 10_000_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The runtime facts the UI labels itself with. Never includes secrets.
 * @param {{config:object, imageProvider:object|null, connectors:{etsy?:{configured:boolean}}}} opts
 * @returns {{provider:string, providerLabel:string, imageProvider:{name:string, model:string}|null,
 *   connectors:{etsy:{configured:boolean}}, version:string}}
 */
export function runtimeMeta({ config, imageProvider, connectors }) {
  return {
    provider: config.provider,
    providerLabel: config.provider === 'anthropic' ? 'LIVE · Anthropic API' : 'SCRIPTED DEMO · no model calls',
    imageProvider: imageProvider ? { name: imageProvider.name, model: imageProvider.model } : null,
    connectors: { etsy: { configured: Boolean(connectors?.etsy?.configured) } },
    version: VERSION,
  };
}

// ---- request plumbing ----------------------------------------------------------------------

const API_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...API_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function hostAllowed(host, allowHosts) {
  if (!host) return false;
  const h = host.toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d+$/, '');
  return LOOPBACK_HOSTS.has(name) || allowHosts.includes(name) || allowHosts.includes(h);
}

function originMatches(origin, host) {
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false; // includes the opaque "null" origin
  }
}

async function readJson(req) {
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'request body must be application/json');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'request body must be a JSON object');
  return body;
}

function requireString(body, field, max, { optional = false } = {}) {
  const value = body[field];
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} must be a non-empty string`);
  if (value.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return value.trim();
}

/** Run a dispatcher/scheduler call whose only failure mode is a bad argument. */
function asBadRequest(fn) {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(400, err.message);
  }
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'malformed path');
  }
}

// ---- static files --------------------------------------------------------------------------

function serveStatic(res, rootName, relPath) {
  const base = STATIC_ROOTS[rootName];
  const rel = decodeSegment(relPath);
  if (rel.includes('\0')) throw new HttpError(400, 'malformed path');
  const target = resolve(base, `.${sep}${rel}`);
  if (!target.startsWith(base + sep)) throw new HttpError(403, 'path escapes the static root');
  let real;
  try {
    real = realpathSync(target);
  } catch {
    throw new HttpError(404, 'not found');
  }
  if (!real.startsWith(realpathSync(base) + sep) || !statSync(real).isFile()) throw new HttpError(404, 'not found');
  const type = CONTENT_TYPES[extname(real).toLowerCase()] || 'application/octet-stream';
  const body = readFileSync(real);
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(type.startsWith('text/html') ? { 'content-security-policy': APP_CSP } : {}),
  });
  res.end(body);
}

// ---- server-sent events --------------------------------------------------------------------

function sseFrame(e) {
  return `id: ${e.seq}\nevent: outpost\ndata: ${JSON.stringify(e)}\n\n`;
}

/** A writer that honours backpressure: frames queue while the socket is full. */
function sseWriter(res) {
  const queue = [];
  let queuedBytes = 0;
  let blocked = false;
  res.on('drain', () => {
    blocked = false;
    while (queue.length && !blocked) {
      const chunk = queue.shift();
      queuedBytes -= chunk.length;
      blocked = !res.write(chunk);
    }
  });
  return (chunk) => {
    if (res.destroyed) return;
    if (!blocked) {
      blocked = !res.write(chunk);
      return;
    }
    queue.push(chunk);
    queuedBytes += chunk.length;
    if (queuedBytes > MAX_SSE_QUEUE_BYTES) res.destroy();
  };
}

function streamEvents(req, res, store, url) {
  const sinceParam = url.searchParams.get('since') ?? req.headers['last-event-id'] ?? '0';
  const since = Number(sinceParam);
  if (!Number.isInteger(since) || since < 0) throw new HttpError(400, 'since must be a non-negative integer');
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  });
  const write = sseWriter(res);
  // Replay and subscribe in the same synchronous step, so no event falls in between.
  for (const e of store.events(since)) write(sseFrame(e));
  const unsubscribe = store.subscribe((e) => write(sseFrame(e)));
  const ping = setInterval(() => write(': ping\n\n'), PING_MS);
  ping.unref();
  res.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}

// ---- artifacts -----------------------------------------------------------------------------

function serveArtifact(res, store, dataDir, id, wantContent) {
  const meta = Object.hasOwn(store.state.artifacts, id) ? store.state.artifacts[id] : null;
  if (!meta) throw new HttpError(404, `unknown artifact ${id}`);
  if (!wantContent) return sendJson(res, 200, meta);
  let content;
  try {
    ({ content } = readArtifact({ store, dataDir }, id));
  } catch (err) {
    throw new HttpError(500, err.message); // missing file or sha256 mismatch: never serve unverified bytes
  }
  res.writeHead(200, {
    ...API_HEADERS,
    'content-type': meta.mime,
    'content-length': content.length,
    'content-security-policy': ARTIFACT_CSP,
  });
  res.end(content);
}

// ---- operator commands ---------------------------------------------------------------------

function commanderId(station) {
  const commander = station?.agents.find((a) => checkCall(station, a.id, 'delegate_task').ok);
  if (!commander) throw new HttpError(409, 'no agent on this station holds a command console');
  return commander.id;
}

function manualLedgerEntry(store, body) {
  if (!LEDGER_KINDS.includes(body.kind)) throw new HttpError(400, `kind must be one of ${LEDGER_KINDS.join(', ')}`);
  const usd = body.amount_usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0 || usd > MAX_MANUAL_USD) {
    throw new HttpError(400, `amount_usd must be a positive number up to ${MAX_MANUAL_USD}`);
  }
  const amountCents = Math.round(usd * 100);
  if (amountCents < 1) throw new HttpError(400, 'amount_usd must be at least 0.01');
  const currency = body.currency === undefined ? 'USD' : body.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'currency must be a 3-letter ISO code like USD');
  const stream = requireString(body, 'stream', 40);
  if (body.memo !== undefined && (typeof body.memo !== 'string' || body.memo.length > 500)) throw new HttpError(400, 'memo must be a string of at most 500 characters');
  let occurredAt = new Date().toISOString();
  if (body.occurred_at !== undefined) {
    const ms = typeof body.occurred_at === 'string' ? Date.parse(body.occurred_at) : NaN;
    if (!Number.isFinite(ms)) throw new HttpError(400, 'occurred_at must be an ISO-8601 date');
    occurredAt = new Date(ms).toISOString();
  }
  const entryId = newId('led');
  store.append('ledger.entry', {
    entryId,
    kind: body.kind,
    amountCents,
    currency,
    stream,
    provenance: 'manual',
    source: { note: 'entered by the operator' },
    occurredAt,
    memo: body.memo?.trim() || undefined,
  }, 'operator');
  return { entryId, amountCents };
}

async function syncConnector(store, connectors, name) {
  if (name !== 'etsy') throw new HttpError(404, `unknown connector "${name}"`);
  const etsy = connectors?.etsy;
  if (!etsy?.configured) {
    throw new HttpError(501, 'etsy connector not configured: set ETSY_API_KEY, ETSY_SHARED_SECRET, ETSY_ACCESS_TOKEN and ETSY_SHOP_ID, then restart the sidecar');
  }
  try {
    return await etsy.syncRevenue(store);
  } catch (err) {
    throw new HttpError(502, err.message); // the connector redacts its secrets from errors
  }
}

/**
 * @param {object} opts
 * @param {object} opts.store event store
 * @param {object} opts.dispatcher sidecar/dispatcher.js instance
 * @param {object} opts.scheduler sidecar/scheduler.js instance
 * @param {{dataDir:string, allowHosts?:string[]}} opts.config
 * @param {object} opts.meta runtimeMeta() result, served with every snapshot
 * @param {{etsy?:object}} [opts.connectors] for POST /api/connectors/:name/sync
 * @returns {import('node:http').Server} not listening yet
 */
export function createServer({ store, dispatcher, scheduler, config, meta, connectors = {} }) {
  const allowHosts = (config.allowHosts || []).map((h) => h.toLowerCase());

  const posts = [
    [/^\/api\/goals$/, async (body) => {
      const goal = requireString(body, 'goal', 4000);
      const firstLine = goal.split('\n')[0];
      const taskId = dispatcher.createTask({ assignee: commanderId(store.state.station), title: `Goal: ${firstLine}`, brief: goal, createdBy: 'operator' });
      return { taskId };
    }],
    [/^\/api\/tasks$/, async (body) => {
      const assignee = requireString(body, 'assignee', 40);
      const title = requireString(body, 'title', 160);
      const brief = requireString(body, 'brief', 20000);
      const inputs = body.inputs ?? [];
      if (!Array.isArray(inputs) || inputs.length > 20 || inputs.some((id) => typeof id !== 'string')) throw new HttpError(400, 'inputs must be an array of up to 20 artifact ids');
      return { taskId: asBadRequest(() => dispatcher.createTask({ assignee, title, brief, inputs, createdBy: 'operator' })) };
    }],
    [/^\/api\/tasks\/([^/]+)\/cancel$/, async (_body, [, taskId]) => {
      if (!Object.hasOwn(store.state.tasks, taskId)) throw new HttpError(404, `unknown task ${taskId}`);
      if (!dispatcher.cancelTask(taskId)) throw new HttpError(409, `task ${taskId} has already finished`);
      return { ok: true, taskId };
    }],
    [/^\/api\/recipes\/([^/]+)$/, async (body, [, name]) => {
      if (!Object.hasOwn(RECIPES, name)) throw new HttpError(404, `unknown recipe "${name}" (available: ${Object.keys(RECIPES).join(', ')})`);
      return asBadRequest(() => dispatcher.startRecipe(name, body.params ?? {}, 'operator'));
    }],
    [/^\/api\/approvals\/([^/]+)$/, async (body, [, approvalId]) => {
      if (!['granted', 'denied'].includes(body.decision)) throw new HttpError(400, 'decision must be "granted" or "denied"');
      const note = requireString(body, 'note', 1000, { optional: true });
      const approval = Object.hasOwn(store.state.approvals, approvalId) ? store.state.approvals[approvalId] : null;
      if (!approval) throw new HttpError(404, `unknown approval ${approvalId}`);
      if (!dispatcher.resolveApproval(approvalId, body.decision, note)) {
        throw new HttpError(409, `approval ${approvalId} is ${approval.status === 'pending' ? 'not held by a running task' : `already ${approval.status}`}`);
      }
      return { ok: true, approvalId, decision: body.decision };
    }],
    [/^\/api\/estop$/, async (body) => {
      if (typeof body.engaged !== 'boolean') throw new HttpError(400, 'engaged must be true or false');
      dispatcher.setEstop(body.engaged);
      return { engaged: store.state.estop };
    }],
    [/^\/api\/ledger\/manual$/, async (body) => manualLedgerEntry(store, body)],
    [/^\/api\/connectors\/([^/]+)\/sync$/, async (_body, [, name]) => syncConnector(store, connectors, name)],
    [/^\/api\/schedules$/, async (body) => {
      const spec = requireString(body, 'spec', 120);
      return { scheduleId: asBadRequest(() => scheduler.addSchedule(spec, body.template, 'operator')) };
    }],
  ];

  async function handlePost(req, res, path) {
    if (req.headers['x-outpost-client'] !== '1') throw new HttpError(403, 'missing x-outpost-client header');
    const { origin } = req.headers;
    if (origin !== undefined && !originMatches(origin, req.headers.host)) throw new HttpError(403, 'cross-origin request refused');
    for (const [pattern, handler] of posts) {
      const match = path.match(pattern);
      if (!match) continue;
      const params = match.map((part, i) => (i === 0 ? part : decodeSegment(part)));
      const body = await readJson(req);
      return sendJson(res, 200, await handler(body, params));
    }
    throw new HttpError(404, `no route for POST ${path}`);
  }

  function handleGet(req, res, url) {
    const path = url.pathname;
    if (path === '/' || path === '/index.html') return serveStatic(res, 'frontend', 'index.html');
    const asset = path.match(/^\/(frontend|shared)\/(.+)$/);
    if (asset) return serveStatic(res, asset[1], asset[2]);
    if (path === '/api/snapshot') return sendJson(res, 200, { seq: store.state.seq, state: store.state, meta });
    if (path === '/api/events') {
      if (req.method !== 'GET') throw new HttpError(405, 'the event stream is GET only');
      return streamEvents(req, res, store, url);
    }
    const art = path.match(/^\/api\/artifacts\/([^/]+)(\/content)?$/);
    if (art) return serveArtifact(res, store, config.dataDir, decodeSegment(art[1]), Boolean(art[2]));
    throw new HttpError(404, `no route for GET ${path}`);
  }

  async function handle(req, res) {
    if (!hostAllowed(req.headers.host, allowHosts)) throw new HttpError(421, 'unrecognised Host header (DNS-rebinding guard); add it to OUTPOST_ALLOW_HOSTS to allow it');
    const url = new URL(req.url, 'http://outpost.local');
    if (req.method === 'POST') return handlePost(req, res, url.pathname);
    if (req.method === 'GET' || req.method === 'HEAD') return handleGet(req, res, url);
    throw new HttpError(405, `method ${req.method} not allowed`);
  }

  return createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500 && !(err instanceof HttpError)) console.error('outpost server:', err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (status === 413) res.setHeader('connection', 'close');
      sendJson(res, status, { error: status === 500 && !(err instanceof HttpError) ? 'internal error' : err.message });
    });
  });
}
