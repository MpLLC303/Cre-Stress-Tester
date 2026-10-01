#!/usr/bin/env node
// DEV FIXTURE ONLY — serves the frontend against a synthetic event sequence so the UI can be
// developed and screenshotted without the runtime. The events here are fabricated test data
// and must never be shown as product state; the real server is sidecar/server.js.
//
//   node scripts/fixture-server.mjs [port]      (default 8790)

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from '../shared/projector.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const station = JSON.parse(readFileSync(join(ROOT, 'config/station.json'), 'utf8'));
const port = Number(process.argv[2] || 8790);

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 450 540"><rect width="450" height="540" fill="#fbf3ea"/><path d="M80 300 Q225 120 370 300" fill="none" stroke="#9cbf8f" stroke-width="10"/><text x="225" y="330" font-family="Georgia,serif" font-size="58" text-anchor="middle" fill="#b5657b">GARDEN ERA</text><text x="225" y="380" font-family="Georgia,serif" font-size="20" text-anchor="middle" fill="#6d8a63">FIXTURE SAMPLE</text></svg>`;

let seq = 0;
const t0 = Date.parse('2026-10-01T15:00:00Z');
const ev = (type, payload, actor = 'system') => ({ seq: ++seq, ts: new Date(t0 + seq * 1000).toISOString(), type, actor, payload });

// Initial history: a pod_listing recipe mid-flight plus a mixed-provenance ledger.
const history = [
  ev('station.loaded', { station }),
  ev('recipe.started', { recipeRunId: 'rcp_1', recipe: 'pod_listing', title: 'POD listing: botanical typography sweatshirts', taskIds: ['tsk_1', 'tsk_2', 'tsk_3', 'tsk_4'] }, 'operator'),
  ev('task.created', { taskId: 'tsk_1', title: 'Trend scan', brief: 'Find demand patterns', assignee: 'nova', createdBy: 'operator', recipeRunId: 'rcp_1', stage: 0, dependsOn: [] }, 'operator'),
  ev('task.created', { taskId: 'tsk_2', title: 'Design draft', brief: 'Original typography design', assignee: 'pixel', createdBy: 'operator', recipeRunId: 'rcp_1', stage: 1, dependsOn: ['tsk_1'] }, 'operator'),
  ev('task.created', { taskId: 'tsk_3', title: 'Listing copy', brief: 'Draft listing', assignee: 'quill', createdBy: 'operator', recipeRunId: 'rcp_1', stage: 2, dependsOn: ['tsk_2'] }, 'operator'),
  ev('task.created', { taskId: 'tsk_4', title: 'Review & publish request', brief: 'Review and request publish', assignee: 'orion', createdBy: 'operator', recipeRunId: 'rcp_1', stage: 3, dependsOn: ['tsk_3'] }, 'operator'),
  ev('task.status', { taskId: 'tsk_1', status: 'running' }),
  ev('run.started', { runId: 'run_1', taskId: 'tsk_1', agentId: 'nova', provider: 'scripted', model: 'scripted', effort: 'medium', tools: ['write_file', 'memory_read'] }),
  ev('agent.status', { agentId: 'nova', status: 'tool', runId: 'run_1', taskId: 'tsk_1', tool: 'write_file', objectId: 'research-bench' }),
  ev('artifact.created', { artifactId: 'art_brief', agentId: 'nova', taskId: 'tsk_1', runId: 'run_1', kind: 'json', title: 'Brief: botanical typography', path: 'artifacts/art_brief/brief.json', mime: 'application/json', bytes: 812, sha256: 'a'.repeat(64) }, 'nova'),
  ev('run.step', { runId: 'run_1', agentId: 'nova', turn: 1, stopReason: 'end_turn', usage: {}, costUsd: 0, text: 'Brief written.' }),
  ev('run.finished', { runId: 'run_1', agentId: 'nova', taskId: 'tsk_1', outcome: 'completed', turns: 2, costUsd: 0, summary: 'Brief written.' }),
  ev('agent.status', { agentId: 'nova', status: 'idle' }),
  ev('task.status', { taskId: 'tsk_1', status: 'done', outputs: ['art_brief'], summary: 'Brief written.' }),
  ev('handoff', { handoffId: 'hnd_1', fromAgent: 'nova', toAgent: 'pixel', fromRoom: 'research', toRoom: 'production', route: ['h-research-production'], taskId: 'tsk_2', artifactIds: ['art_brief'] }),
  ev('task.status', { taskId: 'tsk_2', status: 'running' }),
  ev('run.started', { runId: 'run_2', taskId: 'tsk_2', agentId: 'pixel', provider: 'scripted', model: 'scripted', effort: 'medium', tools: ['render_svg_design'] }),
  ev('agent.status', { agentId: 'pixel', status: 'tool', runId: 'run_2', taskId: 'tsk_2', tool: 'render_svg_design', objectId: 'prod-design' }),
  ev('artifact.created', { artifactId: 'art_svg', agentId: 'pixel', taskId: 'tsk_2', runId: 'run_2', kind: 'svg', title: 'GARDEN ERA (fixture)', path: 'artifacts/art_svg/design.svg', mime: 'image/svg+xml', bytes: SAMPLE_SVG.length, sha256: 'b'.repeat(64) }, 'pixel'),
  ev('agent.status', { agentId: 'orion', status: 'thinking', runId: 'run_9', taskId: 'tsk_9' }),
  ev('agent.status', { agentId: 'flux', status: 'awaiting_approval', runId: 'run_8', taskId: 'tsk_8', tool: 'deliver_order', objectId: 'out-gate' }),
  ev('approval.requested', { approvalId: 'apr_1', runId: 'run_8', agentId: 'flux', taskId: 'tsk_8', tool: 'deliver_order', summary: 'Deliver package "STORM CABIN thumbnails" for order DEMO-ORDER-1', input: '{"package_artifact_id":"art_pkg"}' }),
  ev('ledger.entry', { entryId: 'led_1', kind: 'revenue', amountCents: 4135, currency: 'USD', stream: 'etsy', provenance: 'connector', source: { connector: 'etsy', externalId: 'receipt:1001' }, occurredAt: '2026-09-30T12:00:00Z', memo: 'FIXTURE' }, 'connector:etsy'),
  ev('ledger.entry', { entryId: 'led_2', kind: 'revenue', amountCents: 2000, currency: 'USD', stream: 'fiverr', provenance: 'manual', source: { note: 'fixture manual entry' }, occurredAt: '2026-09-30T13:00:00Z', memo: 'FIXTURE' }, 'operator'),
  ev('ledger.entry', { entryId: 'led_3', kind: 'revenue', amountCents: 1000000, currency: 'USD', stream: 'etsy', provenance: 'agent_claim', source: { note: 'agent said so' }, occurredAt: '2026-09-30T14:00:00Z', memo: 'FIXTURE claim — must not be counted' }, 'tally'),
  ev('run.step', { runId: 'run_2', agentId: 'pixel', turn: 1, stopReason: 'tool_use', usage: { input_tokens: 5200, output_tokens: 900 }, costUsd: 0.0388, text: 'Drafting arched headline.' }),
];

// Live tail: a scripted loop of events so animations (walks, packets, bubbles) can be observed.
function liveEvent(i) {
  const k = i % 8;
  if (k === 0) return ev('agent.status', { agentId: 'nova', status: 'tool', runId: 'run_x', taskId: 'tsk_x', tool: 'web_search', objectId: 'research-terminal' });
  if (k === 1) return ev('agent.status', { agentId: 'quill', status: 'thinking', runId: 'run_y', taskId: 'tsk_3' });
  if (k === 2) return ev('handoff', { handoffId: `hnd_l${i}`, fromAgent: 'pixel', toAgent: 'quill', fromRoom: 'production', toRoom: 'production', route: [], taskId: 'tsk_3', artifactIds: ['art_svg'] });
  if (k === 3) return ev('handoff', { handoffId: `hnd_m${i}`, fromAgent: 'orion', toAgent: 'tally', fromRoom: 'bridge', toRoom: 'ops', route: ['h-bridge-ops'], taskId: 'tsk_z', artifactIds: [] });
  if (k === 4) return ev('agent.status', { agentId: 'nova', status: 'idle' });
  if (k === 5) return ev('agent.status', { agentId: 'tally', status: 'tool', runId: 'run_z', taskId: 'tsk_z', tool: 'read_ledger', objectId: 'ops-ledger' });
  if (k === 6) return ev('handoff', { handoffId: `hnd_n${i}`, fromAgent: 'nova', toAgent: 'pixel', fromRoom: 'research', toRoom: 'production', route: ['h-research-production'], taskId: 'tsk_2', artifactIds: ['art_brief'] });
  return ev('agent.status', { agentId: 'tally', status: 'idle' });
}

const events = [...history];
const clients = new Set();
let i = 0;
setInterval(() => {
  const e = liveEvent(i++);
  events.push(e);
  for (const res of clients) res.write(`id: ${e.seq}\nevent: outpost\ndata: ${JSON.stringify(e)}\n\n`);
}, 1500).unref();

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serveFile(res, base, rel) {
  const abs = resolve(base, `.${rel}`);
  if (!abs.startsWith(base + sep) && abs !== base) return res.writeHead(403).end();
  if (!existsSync(abs) || statSync(abs).isDirectory()) return res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': TYPES[extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(abs));
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/' || p === '/index.html') return serveFile(res, join(ROOT, 'frontend'), '/index.html');
  if (p.startsWith('/frontend/')) return serveFile(res, join(ROOT, 'frontend'), p.slice('/frontend'.length));
  if (p.startsWith('/shared/')) return serveFile(res, join(ROOT, 'shared'), p.slice('/shared'.length));
  if (p === '/api/snapshot') {
    const state = project(events);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ seq: state.seq, state, meta: { provider: 'scripted', providerLabel: 'FIXTURE · synthetic events (dev only)', imageProvider: null, connectors: { etsy: { configured: false } }, version: 'fixture' } }));
  }
  if (p === '/api/events') {
    const since = Number(url.searchParams.get('since') || 0);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    for (const e of events) if (e.seq > since) res.write(`id: ${e.seq}\nevent: outpost\ndata: ${JSON.stringify(e)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const m = p.match(/^\/api\/artifacts\/([^/]+)(\/content)?$/);
  if (m) {
    const state = project(events);
    const meta = state.artifacts[m[1]];
    if (!meta) return res.writeHead(404).end('{"error":"unknown artifact"}');
    if (!m[2]) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(meta));
    const body = meta.kind === 'svg' ? SAMPLE_SVG : JSON.stringify({ fixture: true, title: meta.title }, null, 2);
    return res.writeHead(200, { 'content-type': meta.mime, 'x-content-type-options': 'nosniff' }).end(body);
  }
  if (req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, fixture: true }));
  }
  res.writeHead(404).end('not found');
}).listen(port, '127.0.0.1', () => console.log(`fixture UI server (synthetic events, dev only): http://127.0.0.1:${port}`));
