// Workspace files and artifact access.
//
// Each agent gets a private workspace (<dataDir>/workspaces/<agentId>). Paths from the model are
// untrusted: they are resolved inside the workspace and the nearest existing ancestor is
// realpath'd, so neither `..` nor a symlink planted in the workspace can reach outside it.

import { constants, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { artifactPreview, readArtifact, writeArtifact } from '../artifacts.js';
import { sanitizeSvg } from '../svg.js';

export const MAX_FILE_BYTES = 1024 * 1024;
const LIST_LIMIT = 200;
const ARTIFACT_LIST_LIMIT = 30;

const KIND_BY_EXT = {
  '.md': { kind: 'text', mime: 'text/markdown; charset=utf-8' },
  '.txt': { kind: 'text', mime: 'text/plain; charset=utf-8' },
  '.json': { kind: 'json', mime: 'application/json' },
  '.svg': { kind: 'svg', mime: 'image/svg+xml' },
};

const isInside = (root, p) => p === root || p.startsWith(root + sep);

/**
 * Resolve a model-supplied relative path inside `workspaceDir`, or throw.
 * Rejects absolute paths, NUL bytes, any `..` segment, and anything whose real location
 * (after following symlinks on the nearest existing ancestor) is outside the workspace.
 * @param {string} workspaceDir
 * @param {string} relPath
 * @returns {string} absolute path inside the workspace
 */
export function resolveInWorkspace(workspaceDir, relPath) {
  if (typeof relPath !== 'string') throw new Error('path must be a string');
  if (relPath.includes('\0')) throw new Error('path contains a NUL byte');
  if (isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) throw new Error('path must be relative to your workspace');
  if (relPath.split(/[\\/]+/).includes('..')) throw new Error('path may not contain ".." segments');

  mkdirSync(workspaceDir, { recursive: true });
  const root = realpathSync(workspaceDir);
  const target = resolve(root, relPath);
  if (!isInside(root, target)) throw new Error('path escapes the workspace');

  // lstat (not exists) so a dangling symlink counts as existing and is then caught by realpath.
  let probe = target;
  for (;;) {
    try {
      lstatSync(probe);
      break;
    } catch {
      probe = dirname(probe);
    }
  }
  let real;
  try {
    real = realpathSync(probe);
  } catch {
    throw new Error('path goes through a broken symlink');
  }
  if (!isInside(root, real)) throw new Error('path escapes the workspace through a symlink');
  return target;
}

/** Artifact helper for tools: attributes the artifact to the running agent, task and run. */
export function saveArtifact(ctx, { kind, title, filename, content, mime }) {
  return writeArtifact({ store: ctx.store, dataDir: ctx.dataDir }, {
    agentId: ctx.agent.id,
    taskId: ctx.task?.taskId,
    runId: ctx.runId,
    kind,
    title,
    filename,
    content,
    mime,
  });
}

/** Verified bytes + meta of an artifact (sha256 re-checked against the log). */
export function loadArtifact(ctx, artifactId) {
  return readArtifact({ store: ctx.store, dataDir: ctx.dataDir }, artifactId);
}

/**
 * Check that every id names an existing artifact (optionally of one of `kinds`).
 * @returns {string|null} error message, or null when all are valid
 */
export function checkArtifactIds(ctx, ids, kinds = null) {
  for (const id of ids) {
    const meta = ctx.store.state.artifacts[id];
    if (!meta) return `unknown artifact ${id}`;
    if (kinds && !kinds.includes(meta.kind)) return `artifact ${id} is a ${meta.kind}; expected ${kinds.join(' or ')}`;
  }
  return null;
}

/** read_file: text content of a workspace file. */
export async function readFile(input, ctx) {
  const target = resolveInWorkspace(ctx.workspaceDir, input.path);
  let st;
  try {
    st = statSync(target);
  } catch {
    return { ok: false, output: `no such file: ${input.path}` };
  }
  if (!st.isFile()) return { ok: false, output: `${input.path} is not a file` };
  if (st.size > MAX_FILE_BYTES) return { ok: false, output: `${input.path} is ${st.size} bytes; the limit is ${MAX_FILE_BYTES}` };
  return { ok: true, output: readFileSync(target, 'utf8') };
}

/** write_file: write a workspace file and register it as an artifact. */
export async function writeFile(input, ctx) {
  const target = resolveInWorkspace(ctx.workspaceDir, input.path);
  const type = KIND_BY_EXT[extname(target).toLowerCase()];
  if (!type) return { ok: false, output: `unsupported file type; use one of ${Object.keys(KIND_BY_EXT).join(', ')}` };
  let content = input.content;
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return { ok: false, output: `content exceeds ${MAX_FILE_BYTES} bytes` };
  if (type.kind === 'json') {
    try {
      JSON.parse(content);
    } catch (err) {
      return { ok: false, output: `content is not valid JSON: ${err.message}` };
    }
  }
  if (type.kind === 'svg') {
    const clean = sanitizeSvg(content);
    if (!clean.ok) return { ok: false, output: `svg rejected: ${clean.reason}` };
    content = clean.svg;
  }

  mkdirSync(dirname(target), { recursive: true });
  // Re-check after creating parents: a directory swapped for a symlink in between is refused.
  resolveInWorkspace(ctx.workspaceDir, input.path);
  writeFileSync(target, content, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0) });

  const rel = relative(realpathSync(ctx.workspaceDir), target).split(sep).join('/');
  const art = saveArtifact(ctx, { kind: type.kind, title: rel, filename: basename(target), content, mime: type.mime });
  return { ok: true, output: { path: rel, bytes: art.bytes, artifact_id: art.artifactId, kind: art.kind }, artifactIds: [art.artifactId] };
}

/** list_files: one directory level of the workspace. */
export async function listFiles(input, ctx) {
  const dir = resolveInWorkspace(ctx.workspaceDir, input.dir ?? '.');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { ok: false, output: `no such directory: ${input.dir}` };
  }
  const files = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, LIST_LIMIT)
    .map((e) => (e.isDirectory()
      ? { name: `${e.name}/`, type: 'dir' }
      : { name: e.name, type: e.isFile() ? 'file' : 'other', bytes: e.isFile() ? statSync(join(dir, e.name)).size : undefined }));
  return { ok: true, output: { dir: input.dir ?? '.', entries: files, truncated: entries.length > LIST_LIMIT } };
}

/** read_artifact: metadata plus a text preview (binary artifacts are described, not inlined). */
export async function readArtifactTool(input, ctx) {
  const meta = ctx.store.state.artifacts[input.artifact_id];
  if (!meta) return { ok: false, output: `unknown artifact ${input.artifact_id}` };
  const preview = artifactPreview({ store: ctx.store, dataDir: ctx.dataDir }, input.artifact_id);
  return {
    ok: true,
    output: {
      artifact_id: meta.artifactId,
      kind: meta.kind,
      title: meta.title,
      agent: meta.agentId,
      mime: meta.mime,
      bytes: meta.bytes,
      sha256: meta.sha256,
      created: meta.createdTs,
      preview,
    },
  };
}

/** list_artifacts: the latest artifacts, newest first. */
export async function listArtifacts(_input, ctx) {
  const { artifacts, artifactOrder } = ctx.store.state;
  const latest = artifactOrder.slice(-ARTIFACT_LIST_LIMIT).reverse().map((id) => {
    const a = artifacts[id];
    return { artifact_id: id, kind: a.kind, title: a.title, agent: a.agentId, created: a.createdTs };
  });
  return { ok: true, output: { artifacts: latest, total: artifactOrder.length } };
}
