// Capability law: the station layout IS the permission model.
//
//   room      = a capability-scoped team (agents assigned to it)
//   object    = a tool grant for every agent in that room
//   hallway   = an authorized handoff lane between two rooms
//
// The tool list sent to the model is computed from this module at run start, and the
// loop re-checks every call here before executing it (defense in depth: a model that
// names a tool it was never offered is still refused).

import { OBJECT_GRANTS, INTRINSIC_TOOLS } from '../shared/grants.js';

export { OBJECT_GRANTS, INTRINSIC_TOOLS };

export function roomOf(station, agentId) {
  const agent = station.agents.find((a) => a.id === agentId);
  if (!agent) return null;
  return station.rooms.find((r) => r.id === agent.room) || null;
}

/**
 * Tools available to an agent, each mapped to the station object that grants it
 * (first matching object in the room; the UI walks the sprite to that object).
 * @returns {Array<{tool:string, objectId:string|null}>}
 */
export function toolsForAgent(station, agentId) {
  const room = roomOf(station, agentId);
  if (!room) return [];
  const seen = new Map();
  for (const obj of room.objects || []) {
    for (const tool of OBJECT_GRANTS[obj.type] || []) {
      if (!seen.has(tool)) seen.set(tool, obj.id);
    }
  }
  const hasLane = station.hallways.some((h) => h.a === room.id || h.b === room.id);
  const sameRoomPeers = station.agents.some((a) => a.room === room.id && a.id !== agentId);
  for (const tool of INTRINSIC_TOOLS) {
    if (tool === 'handoff' && !hasLane && !sameRoomPeers) continue;
    if (!seen.has(tool)) seen.set(tool, null);
  }
  return [...seen.entries()].map(([tool, objectId]) => ({ tool, objectId }));
}

/** Is `tool` granted to `agentId` by the current layout? */
export function checkCall(station, agentId, tool) {
  const grant = toolsForAgent(station, agentId).find((g) => g.tool === tool);
  if (!grant) {
    const room = roomOf(station, agentId);
    return { ok: false, objectId: null, reason: `"${tool}" is not granted by any object in ${room ? room.name : 'this agent\'s room'}` };
  }
  return { ok: true, objectId: grant.objectId, reason: '' };
}

function neighbors(station, roomId) {
  const out = [];
  for (const h of station.hallways) {
    if (h.a === roomId) out.push({ room: h.b, hallway: h.id });
    else if (h.b === roomId) out.push({ room: h.a, hallway: h.id });
  }
  return out;
}

/** Shortest hallway route between rooms (BFS). [] for same room, null if unreachable. */
export function route(station, fromRoom, toRoom) {
  if (fromRoom === toRoom) return [];
  const prev = new Map([[fromRoom, null]]);
  const queue = [fromRoom];
  while (queue.length) {
    const cur = queue.shift();
    for (const n of neighbors(station, cur)) {
      if (prev.has(n.room)) continue;
      prev.set(n.room, { room: cur, hallway: n.hallway });
      if (n.room === toRoom) {
        const path = [];
        let at = toRoom;
        while (prev.get(at)) {
          path.unshift(prev.get(at).hallway);
          at = prev.get(at).room;
        }
        return path;
      }
      queue.push(n.room);
    }
  }
  return null;
}

/**
 * Peer handoff: allowed within a room, or across exactly one hallway (an authorized lane).
 * Multi-hop routing is reserved for command delegation from the bridge.
 */
export function canHandoff(station, fromAgentId, toAgentId) {
  const from = station.agents.find((a) => a.id === fromAgentId);
  const to = station.agents.find((a) => a.id === toAgentId);
  if (!from || !to) return { ok: false, route: null, reason: `unknown agent ${!from ? fromAgentId : toAgentId}` };
  if (from.id === to.id) return { ok: false, route: null, reason: 'cannot hand off to yourself' };
  const r = route(station, from.room, to.room);
  if (r === null) return { ok: false, route: null, reason: `no hallway connects ${from.room} and ${to.room}` };
  if (r.length > 1) {
    return { ok: false, route: r, reason: `${from.room} has no direct lane to ${to.room}; route through the bridge (ask the commander)` };
  }
  return { ok: true, route: r, reason: '' };
}

/** Command delegation: the bridge may route work to any reachable room. */
export function canDelegate(station, fromAgentId, toAgentId) {
  const from = station.agents.find((a) => a.id === fromAgentId);
  const to = station.agents.find((a) => a.id === toAgentId);
  if (!from || !to) return { ok: false, route: null, reason: `unknown agent ${!from ? fromAgentId : toAgentId}` };
  if (!checkCall(station, fromAgentId, 'delegate_task').ok) {
    return { ok: false, route: null, reason: `${from.id} has no command console` };
  }
  const r = route(station, from.room, to.room);
  if (r === null) return { ok: false, route: null, reason: `${to.room} is unreachable from ${from.room}` };
  return { ok: true, route: r, reason: '' };
}

/** Structural checks for a station layout; returns a list of problems (empty = valid). */
export function validateStation(station) {
  const problems = [];
  const roomIds = new Set(station.rooms.map((r) => r.id));
  for (const a of station.agents) {
    if (!roomIds.has(a.room)) problems.push(`agent ${a.id} assigned to unknown room ${a.room}`);
  }
  for (const h of station.hallways) {
    if (!roomIds.has(h.a) || !roomIds.has(h.b)) problems.push(`hallway ${h.id} links unknown room`);
  }
  for (const r of station.rooms) {
    for (const o of r.objects || []) {
      if (!OBJECT_GRANTS[o.type]) problems.push(`object ${o.id} has unknown type ${o.type}`);
    }
  }
  const ids = station.agents.map((a) => a.id);
  if (new Set(ids).size !== ids.length) problems.push('duplicate agent ids');
  return problems;
}
