// Artifacts: every file an agent produces is content-addressed, written under
// <dataDir>/artifacts/<artifactId>/<filename>, and announced with an artifact.created
// event. The UI can only show work that exists on disk with a matching sha256.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { WEB_TAINT } from '../shared/events.js';
import { newId } from './ids.js';

const MIME_BY_KIND = {
  text: 'text/markdown; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  listing_draft: 'application/json',
  package: 'application/json',
  delivery: 'application/json',
  publish_receipt: 'application/json',
};

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

function safeFilename(name, fallback) {
  const cleaned = basename(String(name || fallback)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return cleaned.slice(0, 80) || fallback;
}

/** Atomic write: temp file then rename, so a crash never leaves a torn artifact. */
export function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// ---- web taint ---------------------------------------------------------------------------
// Injection containment is structural, not a matter of the model's judgement: a run that saw web
// content (web_search / web_fetch blocks), was handed a tainted input, or read a tainted artifact
// or memory note is tainted for the rest of its life, and everything it writes or asks the
// operator to approve says so. The record lives on the tool ctx as `ctx.taint`.

/**
 * Mutable taint record of one run. Sources only accumulate: a run never becomes clean again.
 * @param {Iterable<string>} [initial] sources known when the run starts (tainted input ids)
 */
export function createTaint(initial = []) {
  const sources = new Set();
  const taint = {
    get tainted() {
      return sources.size > 0;
    },
    /** Mark the run tainted because of `source` ('web', an artifact id, a run id or 'memory:<ns>/<key>'). */
    add(source) {
      if (typeof source === 'string' && source) sources.add(source);
    },
    /** Optional event fields for anything this run produces: {} while it is clean. */
    fields() {
      return sources.size ? { taint: WEB_TAINT, taintSources: [...sources] } : {};
    },
  };
  for (const s of initial) taint.add(s);
  return taint;
}

/**
 * Persist an artifact and emit artifact.created.
 * @param {{store:any, dataDir:string}} env
 * @param {{agentId:string, taskId?:string, runId?:string, kind:string, title:string,
 *          filename?:string, content:string|Buffer, mime?:string,
 *          taint?:'web', taintSources?:string[]}} spec
 *   taint marks content derived from web pages (see createTaint); the fields are omitted when clean
 * @returns {object} the artifact.created payload
 */
export function writeArtifact(env, spec) {
  const buf = Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(String(spec.content), 'utf8');
  if (buf.length > MAX_ARTIFACT_BYTES) throw new Error(`artifact too large (${buf.length} bytes > ${MAX_ARTIFACT_BYTES})`);
  const artifactId = newId('art');
  const ext = { svg: '.svg', json: '.json', listing_draft: '.json', package: '.json', delivery: '.json', publish_receipt: '.json', text: '.md' }[spec.kind] || '';
  const filename = safeFilename(spec.filename, `${spec.kind}${ext}`);
  const rel = join('artifacts', artifactId, filename);
  atomicWrite(join(env.dataDir, rel), buf);
  const payload = {
    artifactId,
    agentId: spec.agentId,
    taskId: spec.taskId,
    runId: spec.runId,
    kind: spec.kind,
    title: String(spec.title).slice(0, 160),
    path: rel,
    mime: spec.mime || MIME_BY_KIND[spec.kind] || 'application/octet-stream',
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
  if (spec.taint) {
    if (spec.taint !== WEB_TAINT) throw new Error(`unknown taint ${JSON.stringify(spec.taint)}`);
    payload.taint = WEB_TAINT;
    payload.taintSources = [...new Set(spec.taintSources?.length ? spec.taintSources : [WEB_TAINT])];
  }
  env.store.append('artifact.created', payload, spec.agentId);
  return payload;
}

/**
 * Read an artifact's bytes and verify them against the logged sha256.
 * @returns {{meta:object, content:Buffer}}
 */
export function readArtifact(env, artifactId) {
  const meta = env.store.state.artifacts[artifactId];
  if (!meta) throw new Error(`unknown artifact ${artifactId}`);
  const content = readFileSync(join(env.dataDir, meta.path));
  const sha = createHash('sha256').update(content).digest('hex');
  if (sha !== meta.sha256) throw new Error(`artifact ${artifactId} failed integrity check (sha256 mismatch)`);
  return { meta, content };
}

/** Text preview for prompts and tool results; binary artifacts are described, not inlined. */
export function artifactPreview(env, artifactId, maxChars = 4000) {
  const { meta, content } = readArtifact(env, artifactId);
  const textual = /^(text\/|application\/json|image\/svg\+xml)/.test(meta.mime);
  if (!textual) return `[${meta.kind} ${meta.mime}, ${meta.bytes} bytes, sha256 ${meta.sha256.slice(0, 12)}…]`;
  const s = content.toString('utf8');
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n…[truncated, ${s.length - maxChars} more chars]` : s;
}
