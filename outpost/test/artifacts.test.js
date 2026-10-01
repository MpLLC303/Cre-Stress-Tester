import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, writeArtifact } from '../sidecar/artifacts.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-'));

/** Record open/fsync/rename calls made through node:fs (the ESM named exports included). */
function traceFs(root) {
  const log = [];
  const names = new Map();
  const rel = (p) => path.relative(root, path.resolve(String(p))).replace(/\.tmp-\d+$/, '.tmp') || '.';
  const orig = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
  fs.openSync = (p, ...rest) => {
    const fd = orig.openSync(p, ...rest);
    names.set(fd, rel(p));
    return fd;
  };
  fs.fsyncSync = (fd) => {
    log.push(`fsync ${names.get(fd)}`);
    return orig.fsyncSync(fd);
  };
  fs.renameSync = (a, b) => {
    log.push(`rename ${rel(a)} -> ${rel(b)}`);
    return orig.renameSync(a, b);
  };
  syncBuiltinESMExports();
  return {
    log,
    restore() {
      Object.assign(fs, orig);
      syncBuiltinESMExports();
    },
  };
}

test('artifacts are fsynced (file, then directories) before artifact.created is logged (RT-11)', { skip: process.platform === 'win32' }, () => {
  const dataDir = tmp();
  const trace = traceFs(dataDir);
  const store = { append: (type, payload) => trace.log.push(`${type} ${payload.artifactId}`) };
  let first;
  let second;
  try {
    first = writeArtifact({ store, dataDir }, { agentId: 'nova', kind: 'text', title: 'one', content: '# one' });
    second = writeArtifact({ store, dataDir }, { agentId: 'nova', kind: 'text', title: 'two', content: '# two' });
  } finally {
    trace.restore();
  }
  const a = `artifacts/${first.artifactId}`;
  const b = `artifacts/${second.artifactId}`;
  assert.deepEqual(trace.log, [
    `fsync ${a}/text.md.tmp`,
    `rename ${a}/text.md.tmp -> ${a}/text.md`,
    `fsync ${a}`,
    'fsync artifacts', // the new artifact directory's entry
    'fsync .', // artifacts/ itself was created by this first write
    `artifact.created ${first.artifactId}`,
    `fsync ${b}/text.md.tmp`,
    `rename ${b}/text.md.tmp -> ${b}/text.md`,
    `fsync ${b}`,
    'fsync artifacts',
    `artifact.created ${second.artifactId}`,
  ]);
  assert.equal(fs.readFileSync(path.join(dataDir, first.path), 'utf8'), '# one');
});

test('atomicWrite overwrites in place durably and leaves no temp file', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  const file = path.join(dir, 'notes', 'key.md');
  atomicWrite(file, 'v1');
  const trace = traceFs(dir);
  try {
    atomicWrite(file, 'v2');
  } finally {
    trace.restore();
  }
  assert.deepEqual(trace.log, ['fsync notes/key.md.tmp', 'rename notes/key.md.tmp -> notes/key.md', 'fsync notes']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'v2');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['key.md']);
});
