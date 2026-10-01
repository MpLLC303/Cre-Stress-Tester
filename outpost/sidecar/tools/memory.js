// Room memory: notes shared by the agents of one room across runs.
//
// The namespace is the agent's room id, so research notes stay in the Research Lab and ledger
// notes in Ops; the archive object is what grants access. Files live at
// <dataDir>/memory/<roomId>/<key>.md.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../artifacts.js';

export const MEMORY_KEY = /^[a-z0-9-]{1,48}$/;
export const MAX_MEMORY_BYTES = 64 * 1024;

function namespaceDir(ctx) {
  const room = ctx.agent.room;
  // The room id comes from station config, but it becomes a path segment, so hold it to a safe shape.
  if (typeof room !== 'string' || !/^[A-Za-z0-9_-]+$/.test(room)) throw new Error(`room id ${JSON.stringify(room)} is not a valid memory namespace`);
  return { namespace: room, dir: join(ctx.dataDir, 'memory', room) };
}

/** memory_read: with a key, the note; without, the list of keys in the room's namespace. */
export async function memoryRead(input, ctx) {
  const { namespace, dir } = namespaceDir(ctx);
  if (input.key === null) {
    let names = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
    } catch {
      // no notes written yet
    }
    const keys = names.map((n) => ({ key: n.slice(0, -3), bytes: statSync(join(dir, n)).size }));
    return { ok: true, output: { namespace, keys } };
  }
  if (!MEMORY_KEY.test(input.key)) return { ok: false, output: 'key must match [a-z0-9-]{1,48}' };
  try {
    return { ok: true, output: readFileSync(join(dir, `${input.key}.md`), 'utf8') };
  } catch {
    return { ok: false, output: `no note "${input.key}" in ${namespace} memory; call memory_read with key null to list keys` };
  }
}

/** memory_write: replace a note and emit memory.written. */
export async function memoryWrite(input, ctx) {
  if (!MEMORY_KEY.test(input.key)) return { ok: false, output: 'key must match [a-z0-9-]{1,48}' };
  const bytes = Buffer.byteLength(input.content, 'utf8');
  if (bytes > MAX_MEMORY_BYTES) return { ok: false, output: `note exceeds ${MAX_MEMORY_BYTES} bytes` };
  const { namespace, dir } = namespaceDir(ctx);
  atomicWrite(join(dir, `${input.key}.md`), input.content);
  ctx.store.append('memory.written', { agentId: ctx.agent.id, namespace, key: input.key, bytes }, ctx.agent.id);
  return { ok: true, output: `saved ${namespace}/${input.key} (${bytes} bytes)` };
}
