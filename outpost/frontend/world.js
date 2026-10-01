// The station view: a pixel-art projection of projector state.
//
// THE LAW applies here more than anywhere: every glow, bubble, count and moving packet is
// derived from client.state (a fold of the event log) or from a 'handoff' event received
// live. Purely cosmetic motion is limited to the starfield, breathing frames, and IDLE-labelled
// agents wandering inside their own room.
//
// Rendering: the world is composed at native resolution (56x33 tiles of 16px) into an
// offscreen frame each animation frame, then blitted onto the visible canvas, whose backing
// store matches its CSS box in device pixels (ResizeObserver + devicePixelRatio):
//   - integer scale, letterboxed and centred, whenever that fills the box reasonably;
//   - otherwise (typically DPR 1) a "sharp bilinear" fill: nearest-neighbour prescale to the
//     next integer, then one smooth downscale, so all world pixels stay the same size;
//   - when the box is too small for legible text, a draggable view at a legible integer scale
//     plus an overview of the whole station (tap/drag it to move the view).
// The static station (hull, floors, walls, doors, corridors) is pre-rendered once per layout.

import { drawText, measure, renderText, wrapText, FONTS } from './pixelfont.js';
import {
  mix, desaturate, makeCanvas,
  makeAgentSheet, AGENT_CELL_W, AGENT_CELL_H, FACING,
  makeObjectSprite, objectLamp, OBJECT_OVERHANG,
  makeThinkingBubble, makeToolBubble, makeApprovalBubble, makeErrorBubble, makePausedBubble, makeHandoffBubble,
  makeNameTag, makeBadge, makePacketSprite, makeChevrons, STATUS_COLORS,
} from './sprites.js';
import { OBJECT_GRANTS } from '../shared/grants.js';

const T = 16;
const SPACE = '#04060c';
const K_EMPTY = 0;
const K_HULL = 1;
const K_WALL = 2;
const K_FLOOR = 3;
const K_DOOR = 4;
const K_CORR = 5;

const WALK_SPEED = 3 * T; // px per second
const PACKET_SPEED = 6 * T; // px per second
const HOP_SPEED = 3.5 * T; // same-room hop
const MAX_PACKETS = 24;
const MAX_PTS = 64;
const MAX_FLASHES = 12;
const FOCUS_MS = 1800;

const BELT = '#0a0f17';
const BELT_EDGE = '#121925';
const CHEVRON_DIM = '#1b2434';

const DIRS4 = [[0, 1], [-1, 0], [1, 0], [0, -1]];
const ADJ = [[0, 1], [-1, 0], [1, 0], [0, -1], [-1, 1], [1, 1], [-1, -1], [1, -1]];

// ------------------------------------------------------------------ small utilities

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32 step on a numeric state held by the caller; returns [0,1). */
function rngNext(holder) {
  let t = (holder.rng = (holder.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function prettyType(type) {
  return String(type || 'object').replace(/_/g, ' ').toUpperCase();
}

function statusLabel(a) {
  switch (a.status) {
    case 'idle': return 'IDLE';
    case 'thinking': return 'THINKING';
    case 'tool': return `TOOL ${a.tool || ''}`.trim();
    case 'awaiting_approval': return `AWAITING APPROVAL${a.tool ? ` ${a.tool}` : ''}`;
    case 'handoff': return 'HANDING OFF';
    case 'error': return 'ERROR';
    case 'paused': return 'PAUSED';
    default: return String(a.status || '?').toUpperCase();
  }
}

// ------------------------------------------------------------------ model from station config

function buildModel(station) {
  const W = Math.max(8, Math.min(256, station.grid?.w | 0 || 56));
  const H = Math.max(8, Math.min(256, station.grid?.h | 0 || 33));
  const N = W * H;
  const inGrid = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const kind = new Uint8Array(N);
  const roomAt = new Int16Array(N).fill(-1);
  const objAt = new Int16Array(N).fill(-1);
  const hallAt = new Int16Array(N).fill(-1);

  const rooms = [];
  const roomIndex = new Map();
  for (const r of station.rooms || []) {
    if (!Array.isArray(r.rect) || r.rect.length !== 4) continue;
    const [x, y, w, h] = r.rect.map((v) => v | 0);
    const color = /^#[0-9a-fA-F]{3,6}$/.test(r.color || '') ? r.color : '#8899aa';
    const room = {
      i: rooms.length, id: r.id, name: String(r.name || r.id), color, x, y, w, h,
      objects: [], walk: [], homes: [], agents: [],
      crew: 0, active: 0, pending: false,
      countKey: -1, countCanvas: null, nameCanvas: null,
      floorA: mix('#171e2a', desaturate(color, 0.3), 0.12),
      floorB: mix('#1a2230', desaturate(color, 0.3), 0.14),
      floorLine: mix('#0e131c', desaturate(color, 0.3), 0.12),
      chevrons: null, packet: null, glow: color,
    };
    rooms.push(room);
    roomIndex.set(room.id, room);
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        if (!inGrid(tx, ty)) continue;
        const t = ty * W + tx;
        const edge = tx === x || ty === y || tx === x + w - 1 || ty === y + h - 1;
        kind[t] = edge ? K_WALL : K_FLOOR;
        roomAt[t] = room.i;
      }
    }
  }

  const objects = [];
  const objIndex = new Map();
  for (const room of rooms) {
    const cfg = (station.rooms || []).find((r) => r.id === room.id);
    for (const o of cfg?.objects || []) {
      if (!Array.isArray(o.at)) continue;
      const tx = o.at[0] | 0;
      const ty = o.at[1] | 0;
      if (!inGrid(tx, ty)) continue;
      const obj = {
        i: objects.length, id: o.id, type: o.type, room: room.i, tx, ty,
        sprite: makeObjectSprite(o.type, room.color), lamp: objectLamp(o.type),
        grants: OBJECT_GRANTS[o.type] || [], activeBy: null, activeTool: null,
        isGate: o.type === 'publish_gate' || o.type === 'delivery_gate',
      };
      objects.push(obj);
      objIndex.set(obj.id, obj);
      room.objects.push(obj);
      if (kind[ty * W + tx] === K_FLOOR) objAt[ty * W + tx] = obj.i;
    }
  }

  const walkable = new Uint8Array(N);
  for (let t = 0; t < N; t++) walkable[t] = kind[t] === K_FLOOR && objAt[t] < 0 ? 1 : 0;

  // hallways: polyline of tile coords, endpoints are doors on room walls
  const hallways = [];
  const hallIndex = new Map();
  const doors = [];
  for (const hw of station.hallways || []) {
    const path = (hw.path || []).filter((p) => Array.isArray(p) && p.length === 2).map((p) => [p[0] | 0, p[1] | 0]);
    if (path.length < 2) continue;
    const hi = hallways.length;
    const tiles = [];
    for (let s = 0; s < path.length - 1; s++) {
      const [x0, y0] = path[s];
      const [x1, y1] = path[s + 1];
      const dx = Math.sign(x1 - x0);
      const dy = Math.sign(y1 - y0);
      if (dx && dy) continue; // not axis-aligned; skip the segment
      let x = x0;
      let y = y0;
      for (;;) {
        if (!tiles.length || tiles[tiles.length - 1][0] !== x || tiles[tiles.length - 1][1] !== y) tiles.push([x, y]);
        if (x === x1 && y === y1) break;
        x += dx;
        y += dy;
      }
    }
    const endpointDoor = (p) => {
      const [x, y] = p;
      if (!inGrid(x, y)) return null;
      const t = y * W + x;
      if (kind[t] !== K_WALL && kind[t] !== K_DOOR) return null;
      const room = rooms[roomAt[t]];
      let ix = 0;
      let iy = 0;
      if (x === room.x) ix = 1;
      else if (x === room.x + room.w - 1) ix = -1;
      else if (y === room.y) iy = 1;
      else iy = -1;
      kind[t] = K_DOOR;
      const door = { t, x, y, room: room.i, ix, iy, hall: hi };
      doors.push(door);
      return door;
    };
    const start = endpointDoor(path[0]);
    const end = endpointDoor(path[path.length - 1]);
    for (const [x, y] of tiles) {
      if (!inGrid(x, y)) continue;
      const t = y * W + x;
      if (kind[t] === K_EMPTY || kind[t] === K_HULL) {
        kind[t] = K_CORR;
        hallAt[t] = hi;
      }
    }
    const pts = new Float32Array(path.length * 2);
    path.forEach(([x, y], k) => {
      pts[k * 2] = x * T + T / 2;
      pts[k * 2 + 1] = y * T + T / 2;
    });
    const cum = new Float32Array(path.length);
    for (let k = 1; k < path.length; k++) {
      cum[k] = cum[k - 1] + Math.abs(pts[k * 2] - pts[k * 2 - 2]) + Math.abs(pts[k * 2 + 1] - pts[k * 2 - 1]);
    }
    const h = {
      i: hi, id: hw.id, a: hw.a, b: hw.b, path, pts, cum, len: cum[path.length - 1], start, end,
      // which endpoint touches which room id
      startRoom: start ? rooms[start.room].id : null, endRoom: end ? rooms[end.room].id : null,
      active: 0, activeColor: null,
    };
    hallways.push(h);
    hallIndex.set(h.id, h);
  }

  // where each room's sign can hang: north-wall stretches clear of doors
  for (const room of rooms) {
    const X = room.x * T;
    const WP = room.w * T;
    const cuts = doors.filter((d) => d.room === room.i && d.y === room.y).map((d) => d.x * T).sort((p, q) => p - q);
    const stretches = [];
    let a = X + 3;
    for (const dx of cuts) {
      if (dx - 2 > a) stretches.push([a, dx - 2]);
      a = dx + T + 2;
    }
    if (X + WP - 3 > a) stretches.push([a, X + WP - 3]);
    if (!stretches.length) stretches.push([X + 3, X + WP - 3]);
    room.signStretches = stretches;
    room.signLine = mix(room.color, '#000000', 0.55);
  }

  // hull plating: one tile around rooms and corridors
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = y * W + x;
      if (kind[t] !== K_EMPTY) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (!inGrid(nx, ny)) continue;
          const k = kind[ny * W + nx];
          if (k !== K_EMPTY && k !== K_HULL) { near = true; break; }
        }
      }
      if (near) kind[t] = K_HULL;
    }
  }

  // walkable tiles per room, and spread-out home tiles
  for (const room of rooms) {
    for (let y = room.y + 1; y < room.y + room.h - 1; y++) {
      for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
        if (!inGrid(x, y)) continue;
        const t = y * W + x;
        if (walkable[t]) room.walk.push(t);
      }
    }
  }

  const agents = (station.agents || []).filter((a) => roomIndex.has(a.room));
  for (const room of rooms) {
    const crew = agents.filter((a) => a.room === room.id);
    const nearObject = (t) => {
      const x = t % W;
      const y = (t / W) | 0;
      for (const [dx, dy] of ADJ) if (inGrid(x + dx, y + dy) && objAt[(y + dy) * W + x + dx] >= 0) return true;
      return false;
    };
    const nearDoor = (t) => {
      const x = t % W;
      const y = (t / W) | 0;
      for (const [dx, dy] of ADJ) if (inGrid(x + dx, y + dy) && kind[(y + dy) * W + x + dx] === K_DOOR) return true;
      return false;
    };
    let cands = room.walk.filter((t) => ((t / W) | 0) > room.y + 1 && !nearObject(t) && !nearDoor(t));
    if (!cands.length) cands = room.walk.filter((t) => !nearObject(t));
    if (!cands.length) cands = room.walk.slice();
    const cx = room.x + room.w / 2 - 0.5;
    const cy = room.y + room.h / 2 - 0.5;
    const chosen = [];
    for (const a of crew) {
      let best = -1;
      let bestScore = -Infinity;
      for (const t of cands) {
        if (chosen.includes(t)) continue;
        const x = t % W;
        const y = (t / W) | 0;
        let minD = 99;
        for (const c of chosen) minD = Math.min(minD, Math.abs((c % W) - x) + Math.abs(((c / W) | 0) - y));
        const centre = Math.abs(x - cx) + Math.abs(y - cy);
        const score = (chosen.length ? Math.min(minD, 6) * 2 : 0) - centre * 0.6 + (hash2(hashStr(a.id), t) % 100) / 400;
        if (score > bestScore) { bestScore = score; best = t; }
      }
      if (best < 0) best = room.walk[0] ?? room.y * W + room.x;
      chosen.push(best);
      room.homes.push(best);
    }
  }

  return {
    station, W, H, N, WPX: W * T, HPX: H * T, kind, roomAt, objAt, hallAt, walkable,
    rooms, roomIndex, objects, objIndex, hallways, hallIndex, doors, agents,
    bfsPrev: new Int32Array(N), bfsSeen: new Int32Array(N), bfsQueue: new Int32Array(N), bfsGen: 1,
  };
}

/** Centre of a w x h rectangle that overlaps no room, nearest the middle of the station. */
function findClearSpot(m, w, h) {
  let best = [m.WPX >> 1, m.HPX >> 1];
  let bestD = Infinity;
  for (let y = 4; y + h <= m.HPX - 4; y += 8) {
    for (let x = 4; x + w <= m.WPX - 4; x += 8) {
      let clear = true;
      for (const r of m.rooms) {
        if (x < (r.x + r.w) * T + 2 && x + w > r.x * T - 2 && y < (r.y + r.h) * T + 2 && y + h > r.y * T - 2) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const d = Math.abs(cx - m.WPX / 2) + Math.abs(cy - m.HPX / 2) * 1.5;
      if (d < bestD) {
        bestD = d;
        best = [Math.round(cx), Math.round(cy)];
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------ static pre-render

function renderStatic(m) {
  const cv = makeCanvas(m.WPX, m.HPX);
  const g = cv.getContext('2d');
  const { W, H, kind } = m;
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? kind[y * W + x] : K_EMPTY);
  const R = (x, y, w, h, c) => {
    g.fillStyle = c;
    g.fillRect(x, y, w, h);
  };

  // hull plating
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = kind[y * W + x];
      if (k === K_EMPTY) continue;
      const X = x * T;
      const Y = y * T;
      const hsh = hash2(x, y);
      R(X, Y, T, T, hsh % 9 === 0 ? '#161d2a' : '#131926');
      if (x % 2 === 0) R(X, Y, 1, T, '#0d121b');
      if (y % 2 === 0) R(X, Y, T, 1, '#0d121b');
      if (x % 2 === 0) R(X + 1, Y, 1, T, '#192030');
      if (y % 2 === 0) R(X, Y + 1, T, 1, '#192030');
      // rivets at panel corners
      const rv = '#2a3447';
      if (x % 2 === 0 && y % 2 === 0) R(X + 3, Y + 3, 1, 1, rv);
      if (x % 2 === 1 && y % 2 === 0) R(X + T - 4, Y + 3, 1, 1, rv);
      if (x % 2 === 0 && y % 2 === 1) R(X + 3, Y + T - 4, 1, 1, rv);
      if (x % 2 === 1 && y % 2 === 1) R(X + T - 4, Y + T - 4, 1, 1, rv);
      if (k === K_HULL && hsh % 23 === 5) {
        // vent grille
        for (let i = 0; i < 3; i++) R(X + 5, Y + 6 + i * 2, 6, 1, '#0a0e15');
      } else if (k === K_HULL && hsh % 31 === 7) {
        R(X + 5, Y + 5, 6, 6, '#0f141e');
        R(X + 6, Y + 6, 4, 4, '#1b2230');
      }
    }
  }
  // hull silhouette edges (light from the top-left)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (kind[y * W + x] === K_EMPTY) continue;
      const X = x * T;
      const Y = y * T;
      if (at(x, y - 1) === K_EMPTY) { R(X, Y, T, 1, '#3a4762'); R(X, Y + 1, T, 1, '#222b3c'); }
      if (at(x - 1, y) === K_EMPTY) { R(X, Y, 1, T, '#323e56'); }
      if (at(x, y + 1) === K_EMPTY) { R(X, Y + T - 1, T, 1, '#070a10'); R(X, Y + T - 2, T, 1, '#0d121b'); }
      if (at(x + 1, y) === K_EMPTY) { R(X + T - 1, Y, 1, T, '#090c13'); }
    }
  }

  // rooms: wall ring, floor grid, inner cap band, north wall face, colour rim
  for (const room of m.rooms) {
    const X = room.x * T;
    const Y = room.y * T;
    const WP = room.w * T;
    const HP = room.h * T;
    const rim = room.color;
    const rimDim = mix(room.color, '#000000', 0.55);
    R(X, Y, WP, HP, '#0f141e');
    R(X + 2, Y + 2, WP - 4, HP - 4, '#161c28');
    R(X, Y, WP, 1, '#3a4762');
    R(X, Y, 1, HP, '#2c374d');
    R(X, Y + HP - 1, WP, 1, '#06080d');
    R(X + WP - 1, Y, 1, HP, '#080b11');
    R(X + 1, Y + 1, WP - 2, 1, rimDim);
    // floor
    for (let ty = room.y + 1; ty < room.y + room.h - 1; ty++) {
      for (let tx = room.x + 1; tx < room.x + room.w - 1; tx++) {
        const FX = tx * T;
        const FY = ty * T;
        R(FX, FY, T, T, (tx + ty) % 2 ? room.floorA : room.floorB);
        R(FX, FY, T, 1, room.floorLine);
        R(FX, FY, 1, T, room.floorLine);
        R(FX + 2, FY + 2, 1, 1, mix(room.floorB, '#ffffff', 0.06));
      }
    }
    const IX = X + T;
    const IY = Y + T;
    const IW = WP - 2 * T;
    const IH = HP - 2 * T;
    // inner cap band (top surface of the wall next to the floor)
    R(IX - 4, IY - 4, IW + 8, 4, '#232c3c');
    R(IX - 4, IY + IH, IW + 8, 4, '#232c3c');
    R(IX - 4, IY - 4, 4, IH + 8, '#232c3c');
    R(IX + IW, IY - 4, 4, IH + 8, '#232c3c');
    // north wall face (we look at it from the south)
    const faceTop = Y + 6;
    R(IX, faceTop, IW, IY - faceTop, mix('#1b2231', room.color, 0.1));
    R(IX, faceTop, IW, 1, '#2f3a4f');
    for (let fx = IX + 6; fx < IX + IW - 2; fx += 12) R(fx, faceTop + 1, 1, IY - faceTop - 2, '#141a26');
    R(IX, faceTop + 4, IW, 1, mix(room.color, '#000000', 0.62));
    // shadows cast onto the floor
    g.fillStyle = 'rgba(0,0,0,0.32)';
    g.fillRect(IX, IY, IW, 3);
    g.fillRect(IX, IY + 3, 2, IH - 3);
    g.fillStyle = 'rgba(0,0,0,0.16)';
    g.fillRect(IX, IY + 3, IW, 2);
    // colour rim along the floor boundary
    R(IX - 1, IY - 1, IW + 2, 1, rim);
    R(IX - 1, IY + IH, IW + 2, 1, rim);
    R(IX - 1, IY - 1, 1, IH + 2, rim);
    R(IX + IW, IY - 1, 1, IH + 2, rim);
    // corner bolts
    R(X + 4, Y + 4, 2, 2, '#2c374b');
    R(X + WP - 6, Y + 4, 2, 2, '#2c374b');
    R(X + 4, Y + HP - 6, 2, 2, '#2c374b');
    R(X + WP - 6, Y + HP - 6, 2, 2, '#2c374b');
  }

  // corridors: belt with side rails
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (kind[y * W + x] !== K_CORR) continue;
      const X = x * T;
      const Y = y * T;
      R(X, Y, T, T, BELT);
      const open = (k) => k === K_CORR || k === K_DOOR;
      const n = open(at(x, y - 1));
      const s = open(at(x, y + 1));
      const w = open(at(x - 1, y));
      const e = open(at(x + 1, y));
      if (!n) { R(X, Y, T, 3, '#1c2433'); R(X, Y, T, 1, '#3a4660'); R(X, Y + 3, T, 1, BELT_EDGE); }
      if (!s) { R(X, Y + T - 3, T, 3, '#1c2433'); R(X, Y + T - 1, T, 1, '#0b0f17'); R(X, Y + T - 4, T, 1, BELT_EDGE); }
      if (!w) { R(X, Y, 3, T, '#1c2433'); R(X, Y, 1, T, '#323e56'); R(X + 3, Y, 1, T, BELT_EDGE); }
      if (!e) { R(X + T - 3, Y, 3, T, '#1c2433'); R(X + T - 1, Y, 1, T, '#0b0f17'); R(X + T - 4, Y, 1, T, BELT_EDGE); }
      // rail corners where two open sides meet diagonally
      if (n && w && !open(at(x - 1, y - 1))) R(X, Y, 3, 3, '#1c2433');
      if (n && e && !open(at(x + 1, y - 1))) R(X + T - 3, Y, 3, 3, '#1c2433');
      if (s && w && !open(at(x - 1, y + 1))) R(X, Y + T - 3, 3, 3, '#1c2433');
      if (s && e && !open(at(x + 1, y + 1))) R(X + T - 3, Y + T - 3, 3, 3, '#1c2433');
    }
  }

  // doors: an opening through the wall with jambs in room colour
  for (const d of m.doors) {
    const room = m.rooms[d.room];
    const X = d.x * T;
    const Y = d.y * T;
    const jamb = '#3c475b';
    const light = room.color;
    if (d.iy !== 0) {
      // door in a north/south wall: opening runs vertically
      R(X + 3, Y, T - 6, T, BELT);
      R(X, Y, 3, T, jamb);
      R(X + T - 3, Y, 3, T, jamb);
      R(X + 2, Y, 1, T, light);
      R(X + T - 3, Y, 1, T, light);
      R(X + 3, d.iy > 0 ? Y + T - 2 : Y, T - 6, 2, '#1c2433');
    } else {
      R(X, Y + 3, T, T - 6, BELT);
      R(X, Y, T, 3, jamb);
      R(X, Y + T - 3, T, 3, jamb);
      R(X, Y + 2, T, 1, light);
      R(X, Y + T - 3, T, 1, light);
      R(d.ix > 0 ? X + T - 2 : X, Y + 3, 2, T - 6, '#1c2433');
    }
  }

  // static conveyor chevrons (dim), pointing from the hallway's first room to its second
  const dim = makeChevrons(CHEVRON_DIM);
  for (const h of m.hallways) drawChevronsOn(g, h, 0, 1, dim);
  return cv;
}

/** Position + direction along a hallway polyline at distance d. Writes into `out` = [x, y, dir, segIdx, distToJoint]. */
function hallPoint(h, d, out) {
  const n = h.path.length;
  let s = 0;
  while (s < n - 2 && h.cum[s + 1] < d) s++;
  const x0 = h.pts[s * 2];
  const y0 = h.pts[s * 2 + 1];
  const x1 = h.pts[s * 2 + 2];
  const y1 = h.pts[s * 2 + 3];
  const segLen = h.cum[s + 1] - h.cum[s];
  const k = segLen > 0 ? (d - h.cum[s]) / segLen : 0;
  out[0] = x0 + (x1 - x0) * k;
  out[1] = y0 + (y1 - y0) * k;
  // 0 right, 1 down, 2 left, 3 up
  out[2] = x1 > x0 ? 0 : x1 < x0 ? 2 : y1 > y0 ? 1 : 3;
  out[3] = s;
  const fromStart = d - h.cum[s];
  const toEnd = h.cum[s + 1] - d;
  out[4] = Math.min(s > 0 ? fromStart : 99, s < n - 2 ? toEnd : 99);
  return out;
}

const _hp = new Float32Array(5);

function drawChevronsOn(g, h, phase, dir, sprites) {
  const start = 13;
  const end = h.len - 13;
  const off = dir > 0 ? phase : (8 - phase) % 8;
  for (let d = start + off; d < end; d += 8) {
    hallPoint(h, d, _hp);
    if (_hp[4] < 6) continue;
    let face = _hp[2];
    if (dir < 0) face = (face + 2) % 4;
    const spr = sprites[face];
    const horizontal = face === 0 || face === 2;
    g.drawImage(spr, Math.round(_hp[0]) - (horizontal ? 2 : 3), Math.round(_hp[1]) - (horizontal ? 3 : 2));
  }
}

function eraseBelt(g, h) {
  g.fillStyle = BELT;
  const n = h.path.length;
  for (let s = 0; s < n - 1; s++) {
    let x0 = h.pts[s * 2];
    let y0 = h.pts[s * 2 + 1];
    let x1 = h.pts[s * 2 + 2];
    let y1 = h.pts[s * 2 + 3];
    // keep door tiles untouched
    if (s === 0) {
      x0 += Math.sign(x1 - x0) * 9;
      y0 += Math.sign(y1 - y0) * 9;
    }
    if (s === n - 2) {
      x1 -= Math.sign(x1 - x0) * 9;
      y1 -= Math.sign(y1 - y0) * 9;
    }
    const minX = Math.min(x0, x1);
    const minY = Math.min(y0, y1);
    g.fillRect(minX - 4, minY - 4, Math.abs(x1 - x0) + 8, Math.abs(y1 - y0) + 8);
  }
}

// ------------------------------------------------------------------ starfield (cosmetic)

function makeStarLayer(w, h, count, seed, palette, near) {
  const cv = makeCanvas(w, h);
  const g = cv.getContext('2d');
  const holder = { rng: seed };
  if (!near) {
    // faint banded nebulae, drawn as stepped discs (pixel-art friendly)
    const blobs = [[0.22, 0.7, 120, '#3a1d6b'], [0.78, 0.3, 140, '#0f3d5c'], [0.55, 0.92, 90, '#3d1430']];
    for (const [fx, fy, r, col] of blobs) {
      for (let k = 0; k < 6; k++) {
        const rr = r * (1 - k / 6);
        g.globalAlpha = 0.035;
        g.fillStyle = col;
        g.beginPath();
        g.arc(Math.round(fx * w), Math.round(fy * h), Math.round(rr), 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalAlpha = 1;
  }
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rngNext(holder) * w);
    const y = Math.floor(rngNext(holder) * h);
    const col = palette[Math.floor(rngNext(holder) * palette.length)];
    g.fillStyle = col;
    g.fillRect(x, y, 1, 1);
    if (near && rngNext(holder) < 0.18) {
      g.globalAlpha = 0.45;
      g.fillRect(x - 1, y, 1, 1);
      g.fillRect(x + 1, y, 1, 1);
      g.fillRect(x, y - 1, 1, 1);
      g.fillRect(x, y + 1, 1, 1);
      g.globalAlpha = 1;
    }
  }
  return cv;
}

// ------------------------------------------------------------------ the world

export function createWorld(canvas, client) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const selectFns = [];
  let model = null;
  let staticLayer = null;
  let frame = null;
  let fx = null;
  let starsFar = null;
  let starsNear = null;
  let stationRef = null;
  let stateRef = null;
  let derivedSeq = -1;
  let dirty = true;

  // view
  let scale = 1;
  let sharp = 0; // >0: integer prescale used for a fractional "sharp bilinear" fill
  let pre = null;
  let preCtx = null;
  let offX = 0;
  let offY = 0;
  let panMode = false;
  let panX = 0;
  let panY = 0;
  let panTargetX = null;
  let panTargetY = null;
  let bw = 0;
  let bh = 0;

  // interaction
  let hover = null; // { type, id }
  let hoverWX = 0;
  let hoverWY = 0;
  let tooltip = null; // { canvas, key }
  let focusT = { id: null, type: null, until: 0 };
  const pointer = { down: false, id: -1, sx: 0, sy: 0, px: 0, py: 0, dragging: false, mini: false };

  // agents (visual state only; truth is client.state.agents)
  const agentViz = new Map();
  let agentList = [];
  const drawables = [];

  // transient effects driven by live 'handoff' events
  const packets = [];
  for (let i = 0; i < MAX_PACKETS; i++) {
    packets.push({
      active: false, pts: new Float32Array(MAX_PTS * 2), cum: new Float32Array(MAX_PTS), n: 0, d: 0, arc: false,
      room: 0, toId: null, count: 0, born: 0, nh: 0,
      halls: new Int16Array(8), hStart: new Float32Array(8), hEnd: new Float32Array(8), hDir: new Int8Array(8),
      hPtStart: new Int16Array(8), hPtEnd: new Int16Array(8), x: 0, y: 0,
    });
  }
  const flashes = [];
  for (let i = 0; i < MAX_FLASHES; i++) flashes.push({ active: false, x: 0, y: 0, t0: 0, color: '#fff' });
  const pendingHandoffs = [];
  const badgeCache = new Map();

  // shared bubble canvases
  const bubbles = {
    thinking: [makeThinkingBubble(1), makeThinkingBubble(2), makeThinkingBubble(3)],
    approval: [makeApprovalBubble(true), makeApprovalBubble(false)],
    error: makeErrorBubble(),
    paused: makePausedBubble(),
    handoff: makeHandoffBubble(),
    tools: new Map(),
  };
  const toolBubble = (tool) => {
    const ab = String(tool || '?').replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || '?';
    let b = bubbles.tools.get(ab);
    if (!b) {
      b = makeToolBubble(ab);
      bubbles.tools.set(ab, b);
    }
    return b;
  };

  // ---------------------------------------------------------------- (re)build on station change

  function rebuild(station) {
    stationRef = station;
    model = station ? buildModel(station) : null;
    if (!model) {
      staticLayer = null;
      agentViz.clear();
      agentList = [];
      return;
    }
    staticLayer = renderStatic(model);
    if (!frame || frame.width !== model.WPX || frame.height !== model.HPX) {
      frame = makeCanvas(model.WPX, model.HPX);
      fx = frame.getContext('2d');
      fx.imageSmoothingEnabled = false;
      starsFar = makeStarLayer(model.WPX, model.HPX, 220, 1337, ['#1e2840', '#27324d', '#34405e', '#465375'], false);
      starsNear = makeStarLayer(model.WPX, model.HPX, 70, 4242, ['#7f90b8', '#a9b8da', '#dfe7ff', '#ffe9c4'], true);
    }
    for (const room of model.rooms) {
      room.nameCanvas = renderText(room.name.toUpperCase(), mix(room.color, '#ffffff', 0.25), 'md');
      room.chevrons = makeChevrons(mix(room.color, '#ffffff', 0.15));
      room.packet = makePacketSprite(room.color);
    }
    // agents: keep positions for agents that stay in the same room
    const prev = new Map(agentViz);
    agentViz.clear();
    for (const cfg of model.agents) {
      const room = model.roomIndex.get(cfg.room);
      const homeIdx = room.agents.length;
      room.agents.push(cfg.id);
      const home = room.homes[homeIdx] ?? room.walk[0] ?? -1;
      const old = prev.get(cfg.id);
      const { sheet, outline } = makeAgentSheet(cfg.palette);
      const av = {
        id: cfg.id, cfg, room: room.i, sheet, outline, home,
        x: 0, y: 0, tile: home, next: -1,
        path: new Int32Array(Math.max(8, room.walk.length + 2)), pathLen: 0, pathPos: 0,
        target: -2, restFacing: FACING.down, facing: FACING.down, mode: 'home',
        pauseUntil: 0, rng: hashStr(cfg.id) || 1, walkDist: 0, phase: hashStr(cfg.id) % 1600,
        placed: false, present: true, status: 'idle',
        tag: makeNameTag(cfg.name || cfg.id, { color: '#eef3fb', accent: cfg.palette?.suit || room.color }),
        tagIdle: makeNameTag(cfg.name || cfg.id, { color: '#aab3c2', suffix: 'IDLE', dim: true }),
        sortY: 0,
      };
      if (old && old.room === av.room && old.placed) {
        av.x = old.x;
        av.y = old.y;
        av.tile = old.tile;
        av.facing = old.facing;
        av.placed = true;
      }
      agentViz.set(cfg.id, av);
    }
    agentList = [...agentViz.values()];
    drawables.length = 0;
    for (const o of model.objects) drawables.push({ kind: 0, ref: o, y: o.ty * T + T - 0.5 });
    for (const av of agentList) drawables.push({ kind: 1, ref: av, y: 0 });
    for (const p of packets) p.active = false;
    hover = null;
    tooltip = null;
    dirty = true;
    layout();
    if (!canvas.hasAttribute('aria-label')) {
      canvas.setAttribute('aria-label', `Station map ${station.name || ''}: ${model.rooms.length} rooms, ${model.agents.length} crew`.replace(/\s+/g, ' '));
    }
  }

  // ---------------------------------------------------------------- derived state (on change only)

  function tileX(t) { return t % model.W; }
  function tileY(t) { return (t / model.W) | 0; }
  function anchorX(t) { return tileX(t) * T + T / 2; }
  function anchorY(t) { return tileY(t) * T + T - 1; }

  function standTileFor(obj, roomIdx, claimed) {
    let fallback = -1;
    for (const [dx, dy] of ADJ) {
      const x = obj.tx + dx;
      const y = obj.ty + dy;
      if (x < 0 || y < 0 || x >= model.W || y >= model.H) continue;
      const t = y * model.W + x;
      if (!model.walkable[t] || model.roomAt[t] !== roomIdx) continue;
      if (!claimed.has(t)) return t;
      if (fallback < 0) fallback = t;
    }
    return fallback;
  }

  function facingToward(fromT, ox, oy) {
    const dx = ox - tileX(fromT);
    const dy = oy - tileY(fromT);
    if (dx !== 0 && Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? FACING.right : FACING.left;
    if (dy < 0) return FACING.up;
    return FACING.down;
  }

  function recomputeDerived(state) {
    derivedSeq = state.seq;
    stateRef = state;
    dirty = false;
    for (const o of model.objects) {
      o.activeBy = null;
      o.activeTool = null;
    }
    for (const room of model.rooms) {
      room.crew = 0;
      room.active = 0;
      room.pending = false;
    }
    const agents = state.agents || {};
    for (const av of agentList) {
      const a = agents[av.id];
      av.present = !!a;
      if (!a) continue;
      av.status = a.status;
      av.toolBubble = a.status === 'tool' ? toolBubble(a.tool) : null;
      const room = model.rooms[av.room];
      room.crew += 1;
      if (a.status !== 'idle') room.active += 1;
      if (a.status === 'tool' && a.objectId) {
        const o = model.objIndex.get(a.objectId);
        if (o && !o.activeBy) {
          o.activeBy = av.id;
          o.activeTool = a.tool || null;
        }
      }
    }
    for (const id in state.approvals || {}) {
      const ap = state.approvals[id];
      if (ap.status !== 'pending') continue;
      const av = agentViz.get(ap.agentId);
      if (av) model.rooms[av.room].pending = true;
    }
    // movement targets
    const claimed = new Set();
    for (const av of agentList) {
      const a = agents[av.id];
      if (!a) continue;
      let target = -1;
      let rest = FACING.down;
      let mode = 'home';
      const obj = a.objectId ? model.objIndex.get(a.objectId) : null;
      if ((a.status === 'tool' || a.status === 'awaiting_approval') && obj && obj.room === av.room) {
        target = standTileFor(obj, av.room, claimed);
        if (target >= 0) {
          rest = facingToward(target, obj.tx, obj.ty);
          mode = 'object';
        }
      }
      if (target < 0 && a.status === 'idle') mode = 'idle';
      if (target < 0 && mode !== 'idle') target = av.home;
      if (mode === 'idle') {
        if (av.mode !== 'idle') {
          // start wandering after a short pause where it stands
          av.mode = 'idle';
          av.pauseUntil = 0;
          av.target = av.tile;
        }
        if (av.target >= 0) claimed.add(av.target);
        if (!av.placed) place(av, av.home);
        continue;
      }
      av.mode = mode;
      av.restFacing = rest;
      if (target >= 0) claimed.add(target);
      if (!av.placed) place(av, target);
      else retarget(av, target);
    }
  }

  function place(av, t) {
    if (t < 0) return;
    av.x = anchorX(t);
    av.y = anchorY(t);
    av.tile = t;
    av.next = -1;
    av.pathLen = 0;
    av.pathPos = 0;
    av.target = t;
    av.facing = av.mode === 'object' ? av.restFacing : FACING.down;
    av.placed = true;
  }

  function retarget(av, t) {
    if (t < 0 || av.target === t) return;
    av.target = t;
    const from = av.next >= 0 ? av.next : av.tile;
    av.pathLen = bfs(from, t, av.room, av.path);
    av.pathPos = 0;
    if (av.pathLen < 0) {
      // unreachable (walled in): stay where we are rather than walk through walls
      av.pathLen = 0;
    }
  }

  /** 4-connected BFS over walkable tiles of one room. Writes the path (excluding `from`) into out. */
  function bfs(from, to, roomIdx, out) {
    if (from === to) return 0;
    const { W, H, walkable, roomAt, bfsPrev, bfsSeen, bfsQueue } = model;
    const gen = ++model.bfsGen;
    let head = 0;
    let tail = 0;
    bfsQueue[tail++] = from;
    bfsSeen[from] = gen;
    bfsPrev[from] = -1;
    let found = false;
    while (head < tail) {
      const t = bfsQueue[head++];
      if (t === to) { found = true; break; }
      const x = t % W;
      const y = (t / W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DIRS4[k][0];
        const ny = y + DIRS4[k][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (bfsSeen[n] === gen) continue;
        if (n !== to && (!walkable[n] || roomAt[n] !== roomIdx)) continue;
        if (n === to && roomAt[n] !== roomIdx) continue;
        bfsSeen[n] = gen;
        bfsPrev[n] = t;
        bfsQueue[tail++] = n;
      }
    }
    if (!found) return -1;
    let len = 0;
    for (let t = to; t !== from && t >= 0; t = bfsPrev[t]) len++;
    if (len > out.length) return -1;
    let i = len - 1;
    for (let t = to; t !== from && t >= 0; t = bfsPrev[t]) out[i--] = t;
    return len;
  }

  function pickWanderTarget(av) {
    const room = model.rooms[av.room];
    if (!room.walk.length) return av.tile;
    for (let tries = 0; tries < 6; tries++) {
      const t = room.walk[Math.floor(rngNext(av) * room.walk.length)];
      if (t === av.tile) continue;
      let taken = false;
      for (const other of agentList) if (other !== av && (other.target === t || other.tile === t)) taken = true;
      if (!taken) return t;
    }
    return av.tile;
  }

  // ---------------------------------------------------------------- per-frame updates

  function updateAgents(dt, now) {
    for (const av of agentList) {
      if (!av.present || !av.placed) continue;
      const idleNow = av.mode === 'idle';
      if (idleNow && av.next < 0 && av.pathPos >= av.pathLen) {
        if (av.pauseUntil === 0) av.pauseUntil = now + 2000 + rngNext(av) * 3000;
        else if (now >= av.pauseUntil) {
          av.pauseUntil = 0;
          const t = pickWanderTarget(av);
          av.target = -2;
          retarget(av, t);
          if (av.pathLen === 0) av.pauseUntil = now + 2000;
        }
      }
      let budget = WALK_SPEED * dt;
      while (budget > 0) {
        if (av.next < 0) {
          if (av.pathPos < av.pathLen) av.next = av.path[av.pathPos++];
          else break;
        }
        const nx = anchorX(av.next);
        const ny = anchorY(av.next);
        const dx = nx - av.x;
        const dy = ny - av.y;
        if (dx > 0.01) av.facing = FACING.right;
        else if (dx < -0.01) av.facing = FACING.left;
        else if (dy > 0.01) av.facing = FACING.down;
        else if (dy < -0.01) av.facing = FACING.up;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist <= budget) {
          av.x = nx;
          av.y = ny;
          av.tile = av.next;
          av.next = -1;
          budget -= dist;
          av.walkDist += dist;
        } else {
          const k = budget / dist;
          av.x += dx * k;
          av.y += dy * k;
          av.walkDist += budget;
          budget = 0;
        }
      }
      if (av.next < 0 && av.pathPos >= av.pathLen && av.mode !== 'idle') av.facing = av.restFacing;
    }
  }

  function agentMoving(av) {
    return av.next >= 0 || av.pathPos < av.pathLen;
  }

  // ---------------------------------------------------------------- packets (live 'handoff' events only)

  function pushPt(p, x, y) {
    if (p.n >= MAX_PTS) return;
    p.pts[p.n * 2] = x;
    p.pts[p.n * 2 + 1] = y;
    p.n++;
  }

  function spawnPacket(h, now) {
    if (!model) return;
    let p = null;
    for (const q of packets) if (!q.active) { p = q; break; }
    if (!p) {
      p = packets[0];
      for (const q of packets) if (q.born < p.born) p = q;
    }
    const fromAv = agentViz.get(h.fromAgent);
    const toAv = agentViz.get(h.toAgent);
    const fromRoom = model.roomIndex.get(h.fromRoom) || (fromAv ? model.rooms[fromAv.room] : null);
    const toRoom = model.roomIndex.get(h.toRoom) || (toAv ? model.rooms[toAv.room] : null);
    if (!fromRoom || !toRoom) return;
    p.n = 0;
    p.nh = 0;
    p.d = 0;
    p.room = fromRoom.i;
    p.toId = toAv ? toAv.id : null;
    p.count = Array.isArray(h.artifactIds) ? h.artifactIds.length : 0;
    p.born = now;
    const sx = fromAv ? fromAv.x : (fromRoom.x + fromRoom.w / 2) * T;
    const sy = fromAv ? fromAv.y - 9 : (fromRoom.y + fromRoom.h / 2) * T;
    pushPt(p, sx, sy);
    const route = Array.isArray(h.route) ? h.route : [];
    p.arc = route.length === 0;
    let cur = fromRoom.id;
    for (const hid of route) {
      const hw = model.hallIndex.get(hid);
      if (!hw || !hw.start || !hw.end) continue;
      let forward;
      if (hw.startRoom === cur) forward = true;
      else if (hw.endRoom === cur) forward = false;
      else {
        const lx = p.pts[(p.n - 1) * 2];
        const ly = p.pts[(p.n - 1) * 2 + 1];
        forward = Math.abs(lx - hw.pts[0]) + Math.abs(ly - hw.pts[1]) <= Math.abs(lx - hw.pts[hw.pts.length - 2]) + Math.abs(ly - hw.pts[hw.pts.length - 1]);
      }
      const entry = forward ? hw.start : hw.end;
      const exit = forward ? hw.end : hw.start;
      // step just inside the room, then out through the door
      pushPt(p, entry.x * T + T / 2 + entry.ix * 12, entry.y * T + T / 2 + entry.iy * 12);
      const k = p.nh;
      if (k < 8) {
        p.halls[k] = hw.i;
        p.hDir[k] = forward ? 1 : -1;
        p.hPtStart[k] = p.n;
      }
      const np = hw.path.length;
      for (let j = 0; j < np; j++) {
        const idx = forward ? j : np - 1 - j;
        pushPt(p, hw.pts[idx * 2], hw.pts[idx * 2 + 1]);
      }
      if (k < 8) {
        p.hPtEnd[k] = p.n - 1;
        p.nh++;
      }
      pushPt(p, exit.x * T + T / 2 + exit.ix * 12, exit.y * T + T / 2 + exit.iy * 12);
      cur = forward ? hw.endRoom : hw.startRoom;
    }
    const ex = toAv ? toAv.x : (toRoom.x + toRoom.w / 2) * T;
    const ey = toAv ? toAv.y - 9 : (toRoom.y + toRoom.h / 2) * T;
    pushPt(p, ex, ey);
    p.cum[0] = 0;
    for (let i = 1; i < p.n; i++) {
      p.cum[i] = p.cum[i - 1] + Math.hypot(p.pts[i * 2] - p.pts[i * 2 - 2], p.pts[i * 2 + 1] - p.pts[i * 2 - 1]);
    }
    for (let k = 0; k < p.nh; k++) {
      p.hStart[k] = p.cum[p.hPtStart[k]];
      p.hEnd[k] = p.cum[p.hPtEnd[k]];
    }
    p.active = p.n >= 2;
  }

  function packetPos(p, d, out) {
    if (p.arc) {
      const total = p.cum[p.n - 1] || 1;
      const k = Math.max(0, Math.min(1, d / total));
      out[0] = p.pts[0] + (p.pts[2] - p.pts[0]) * k;
      out[1] = p.pts[1] + (p.pts[3] - p.pts[1]) * k - Math.sin(k * Math.PI) * Math.min(18, 6 + total * 0.25);
      return out;
    }
    let i = 0;
    while (i < p.n - 2 && p.cum[i + 1] < d) i++;
    const seg = p.cum[i + 1] - p.cum[i];
    const k = seg > 0 ? Math.max(0, Math.min(1, (d - p.cum[i]) / seg)) : 1;
    out[0] = p.pts[i * 2] + (p.pts[i * 2 + 2] - p.pts[i * 2]) * k;
    out[1] = p.pts[i * 2 + 1] + (p.pts[i * 2 + 3] - p.pts[i * 2 + 1]) * k;
    return out;
  }

  const _pp = new Float32Array(2);

  function updatePackets(dt, now) {
    for (const h of model.hallways) h.active = 0;
    for (const p of packets) {
      if (!p.active) continue;
      // the receiving end follows the receiver's sprite
      const toAv = p.toId ? agentViz.get(p.toId) : null;
      if (toAv && toAv.placed) {
        const i = p.n - 1;
        p.pts[i * 2] = toAv.x;
        p.pts[i * 2 + 1] = toAv.y - 9;
        p.cum[i] = p.cum[i - 1] + Math.hypot(p.pts[i * 2] - p.pts[i * 2 - 2], p.pts[i * 2 + 1] - p.pts[i * 2 - 1]);
      }
      p.d += (p.arc ? HOP_SPEED : PACKET_SPEED) * dt;
      const total = p.cum[p.n - 1];
      if (p.d >= total) {
        p.active = false;
        spawnFlash(p.pts[(p.n - 1) * 2], p.pts[(p.n - 1) * 2 + 1], model.rooms[p.room].color, now);
        continue;
      }
      for (let k = 0; k < p.nh; k++) {
        if (p.d >= p.hStart[k] - 4 && p.d <= p.hEnd[k] + 4) {
          const hw = model.hallways[p.halls[k]];
          hw.active = p.hDir[k];
          hw.activeColor = p.room;
        }
      }
    }
  }

  function spawnFlash(x, y, color, now) {
    let f = flashes[0];
    for (const q of flashes) if (!q.active) { f = q; break; }
    f.active = true;
    f.x = x;
    f.y = y;
    f.t0 = now;
    f.color = color;
  }

  // ---------------------------------------------------------------- drawing

  // Room sign: name + live crew count, mounted on the north wall in the leftmost stretch
  // that is clear of doors (falls back to the widest stretch).
  function drawRoomPlates(g) {
    for (const room of model.rooms) {
      const key = room.crew * 1000 + room.active;
      if (room.countKey !== key) {
        room.countKey = key;
        room.countCanvas = renderText(`${room.crew} CREW · ${room.active} ACTIVE`, room.active ? '#d4f5e2' : '#8d97a8', 'sm');
      }
      const w = Math.max(room.nameCanvas.width, room.countCanvas.width) + 7;
      let sx = room.signStretches[0][0];
      let widest = 0;
      let found = false;
      for (const [a, b] of room.signStretches) {
        if (b - a >= w) { sx = a; found = true; break; }
        if (b - a > widest) { widest = b - a; sx = a; }
      }
      if (!found) sx = Math.max(room.x * T + 2, sx);
      const sy = room.y * T;
      g.fillStyle = '#070a11';
      g.fillRect(sx, sy, w, 15);
      g.fillStyle = room.signLine;
      g.fillRect(sx, sy + 14, w, 1);
      g.fillStyle = room.color;
      g.fillRect(sx, sy, 2, 15);
      g.drawImage(room.nameCanvas, sx + 4, sy + 1);
      g.drawImage(room.countCanvas, sx + 4, sy + 9);
    }
  }

  function drawHalo(g, x, y, w, h, color, strength) {
    g.fillStyle = color;
    for (let k = 3; k >= 1; k--) {
      g.globalAlpha = 0.07 * (4 - k) * strength;
      const e = k * 2;
      g.fillRect(x - e + 2, y - e, w + e * 2 - 4, h + e * 2);
      g.fillRect(x - e, y - e + 2, w + e * 2, h + e * 2 - 4);
    }
    g.globalAlpha = 1;
  }

  function drawObject(g, o, now, state) {
    const spr = o.sprite;
    const X = o.tx * T;
    const Y = o.ty * T - OBJECT_OVERHANG;
    let f = 0;
    if (o.activeBy) {
      const tick = (now / 85) | 0;
      f = (hash2(tick, o.i) & 7) < 2 ? 2 : 1;
    }
    g.drawImage(spr.frames[f], X, Y);
    if (o.lamp) {
      const room = model.rooms[o.room];
      let color = '#2a1d12';
      let lit = false;
      if (state.estop) { color = '#ff2a3c'; lit = true; }
      else if (room.pending) { color = '#ffb020'; lit = true; }
      const lx = X + o.lamp.x;
      const ly = o.ty * T + o.lamp.y;
      if (lit) {
        const pulse = state.estop ? 1 : 0.55 + 0.45 * Math.sin(now / 260);
        g.globalAlpha = 0.28 * pulse;
        g.fillStyle = color;
        g.fillRect(lx - 3, ly - 2, o.lamp.w + 6, o.lamp.h + 4);
        g.fillRect(lx - 2, ly - 3, o.lamp.w + 4, o.lamp.h + 6);
        g.globalAlpha = 1;
      }
      g.fillStyle = color;
      g.fillRect(lx, ly, o.lamp.w, o.lamp.h);
      if (lit) {
        g.fillStyle = '#fff4d8';
        g.fillRect(lx, ly, 1, 1);
      }
    }
  }

  function drawAgent(g, av, now, frozen, highlight) {
    if (!av.present || !av.placed) return;
    const ax = Math.round(av.x);
    const ay = Math.round(av.y);
    g.fillStyle = 'rgba(0,0,0,0.38)';
    g.fillRect(ax - 4, ay - 2, 8, 2);
    g.fillRect(ax - 5, ay - 1, 10, 1);
    let fr = 0;
    if (!frozen) {
      if (agentMoving(av)) fr = (av.walkDist / 6) & 1 ? 3 : 2;
      else fr = (now + av.phase) % 1700 < 1150 ? 0 : 1;
    }
    const sx = fr * AGENT_CELL_W;
    const sy = av.facing * AGENT_CELL_H;
    if (highlight > 0) {
      g.globalAlpha = highlight;
      g.drawImage(av.outline, sx, sy, AGENT_CELL_W, AGENT_CELL_H, ax - 7, ay - 17, AGENT_CELL_W, AGENT_CELL_H);
      g.globalAlpha = 1;
    }
    g.drawImage(av.sheet, sx, sy, AGENT_CELL_W, AGENT_CELL_H, ax - 7, ay - 17, AGENT_CELL_W, AGENT_CELL_H);
  }

  function bubbleFor(a, av, now) {
    switch (a.status) {
      case 'thinking': return bubbles.thinking[((now / 380) | 0) % 3];
      case 'tool': return av.toolBubble || toolBubble(a.tool);
      case 'awaiting_approval': return bubbles.approval[((now / 420) | 0) % 2];
      case 'error': return bubbles.error;
      case 'paused': return bubbles.paused;
      case 'handoff': return bubbles.handoff;
      default: return null;
    }
  }

  function drawOverlays(g, state, now) {
    const agents = state.agents || {};
    for (const av of agentList) {
      const a = agents[av.id];
      if (!a || !av.placed) continue;
      const ax = Math.round(av.x);
      const ay = Math.round(av.y);
      // name tag under the feet, status bubble off the upper-right of the helmet, so the
      // object an agent works at (above it) stays visible
      const tag = a.status === 'idle' ? av.tagIdle : av.tag;
      g.drawImage(tag.canvas, ax - (tag.w >> 1), ay + 1);
      const b = bubbleFor(a, av, now);
      if (b) g.drawImage(b.canvas, ax + 5, ay - 12 - b.h);
    }
  }

  function drawPackets(g, now) {
    for (const p of packets) {
      if (!p.active) continue;
      const room = model.rooms[p.room];
      // trail
      g.fillStyle = room.color;
      for (let k = 3; k >= 1; k--) {
        const d = p.d - k * 5;
        if (d <= 0) continue;
        packetPos(p, d, _pp);
        g.globalAlpha = 0.12 * (4 - k);
        g.fillRect(Math.round(_pp[0]) - 1, Math.round(_pp[1]) - 1, 3, 3);
      }
      packetPos(p, p.d, _pp);
      const x = Math.round(_pp[0]);
      const y = Math.round(_pp[1]);
      const pulse = 0.75 + 0.25 * Math.sin((now - p.born) / 120);
      g.globalAlpha = 0.16 * pulse;
      g.fillRect(x - 7, y - 5, 14, 10);
      g.fillRect(x - 5, y - 7, 10, 14);
      g.globalAlpha = 0.3 * pulse;
      g.fillRect(x - 5, y - 4, 10, 8);
      g.fillRect(x - 4, y - 5, 8, 10);
      g.globalAlpha = 1;
      g.drawImage(room.packet, x - 3, y - 3);
      if (p.count > 1) {
        let badge = badgeCache.get(p.count);
        if (!badge) {
          badge = makeBadge(p.count > 99 ? '99+' : String(p.count));
          badgeCache.set(p.count, badge);
        }
        g.drawImage(badge.canvas, x + 3, y - 10);
      }
    }
    for (const f of flashes) {
      if (!f.active) continue;
      const t = (now - f.t0) / 380;
      if (t >= 1) { f.active = false; continue; }
      const r = Math.round(3 + t * 9);
      const x = Math.round(f.x);
      const y = Math.round(f.y);
      g.globalAlpha = 1 - t;
      g.fillStyle = f.color;
      g.fillRect(x - r, y - r, r * 2, 1);
      g.fillRect(x - r, y + r - 1, r * 2, 1);
      g.fillRect(x - r, y - r, 1, r * 2);
      g.fillRect(x + r - 1, y - r, 1, r * 2);
      g.globalAlpha = 1;
    }
  }

  function drawActiveHalls(g, now) {
    const phase = Math.floor((now / 1000) * 32) % 8;
    for (const h of model.hallways) {
      if (!h.active) continue;
      eraseBelt(g, h);
      drawChevronsOn(g, h, phase, h.active, model.rooms[h.activeColor].chevrons);
    }
  }

  function outlineRect(g, x, y, w, h, color, alpha) {
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.fillRect(x, y, w, 1);
    g.fillRect(x, y + h - 1, w, 1);
    g.fillRect(x, y, 1, h);
    g.fillRect(x + w - 1, y, 1, h);
    g.globalAlpha = 1;
  }

  const _box = [0, 0, 0, 0];

  /** Outline box of an object's sprite in world px (shared scratch array: copy if kept). */
  function objectBox(o) {
    const s = o.sprite;
    _box[0] = o.tx * T + s.left - 1;
    _box[1] = o.ty * T - OBJECT_OVERHANG + s.top - 1;
    _box[2] = s.right - s.left + 2;
    _box[3] = s.bottom - s.top + 2;
    return _box;
  }

  function drawHighlights(g, now) {
    const focusing = focusT.id && now < focusT.until;
    const fk = focusing ? (focusT.until - now) / FOCUS_MS : 0;
    const blink = focusing ? (((now / 150) | 0) % 2 ? 1 : 0.45) : 0;
    if (hover && hover.type === 'room') {
      const r = model.roomIndex.get(hover.id);
      if (r) outlineRect(g, r.x * T - 1, r.y * T - 1, r.w * T + 2, r.h * T + 2, '#ffffff', 0.55);
    }
    if (hover && hover.type === 'object') {
      const o = model.objIndex.get(hover.id);
      if (o) {
        const [x, y, w, h] = objectBox(o);
        outlineRect(g, x, y, w, h, '#ffffff', 0.8);
      }
    }
    if (focusing) {
      if (focusT.type === 'room') {
        const r = model.roomIndex.get(focusT.id);
        if (r) {
          const e = Math.round((1 - fk) * 4);
          outlineRect(g, r.x * T - 2 - e, r.y * T - 2 - e, r.w * T + 4 + e * 2, r.h * T + 4 + e * 2, r.color, blink * Math.min(1, fk * 2));
          outlineRect(g, r.x * T - 1, r.y * T - 1, r.w * T + 2, r.h * T + 2, '#ffffff', blink * Math.min(1, fk * 2) * 0.8);
        }
      } else if (focusT.type === 'object') {
        const o = model.objIndex.get(focusT.id);
        if (o) {
          const [x, y, w, h] = objectBox(o);
          const e = Math.round((1 - fk) * 3);
          outlineRect(g, x - e, y - e, w + e * 2, h + e * 2, '#ffffff', blink * Math.min(1, fk * 2));
        }
      } else if (focusT.type === 'agent') {
        const av = agentViz.get(focusT.id);
        if (av && av.placed) {
          const r = Math.round(9 + (1 - fk) * 5);
          const x = Math.round(av.x);
          const y = Math.round(av.y) - 8;
          outlineRect(g, x - r, y - r, r * 2, r * 2, '#ffffff', blink * Math.min(1, fk * 2));
        }
      }
    }
  }

  function drawEstop(g, now) {
    g.fillStyle = 'rgba(255,24,40,0.15)';
    g.fillRect(0, 0, model.WPX, model.HPX);
    const label = 'E-STOP';
    const sc = 4;
    const tw = measure(label, 'md', sc);
    const th = FONTS.md.h * sc;
    const pw = tw + 40;
    const ph = th + 34;
    let cx;
    let cy;
    if (panMode) {
      // centre of what the operator can currently see
      cx = Math.round((view.x + view.w / 2 - offX) / scale);
      cy = Math.round((view.y + view.h / 2 - offY) / scale);
    } else {
      if (!model.estopAt) model.estopAt = findClearSpot(model, pw + 8, ph + 8);
      cx = model.estopAt[0];
      cy = model.estopAt[1];
    }
    const px = cx - (pw >> 1);
    const py = cy - (ph >> 1);
    g.fillStyle = 'rgba(30,2,6,0.88)';
    g.fillRect(px, py, pw, ph);
    // hazard stripes top and bottom
    for (let x = px; x < px + pw; x += 8) {
      g.fillStyle = '#ffcc00';
      g.fillRect(x, py, 4, 4);
      g.fillRect(x + 4, py + ph - 4, 4, 4);
    }
    outlineRect(g, px, py, pw, ph, '#ff3b4f', 1);
    const blink = ((now / 500) | 0) % 2 ? 1 : 0.75;
    g.globalAlpha = blink;
    drawText(g, label, cx - (tw >> 1) + 2, py + 10 + 2, '#3a0006', 'md', sc);
    drawText(g, label, cx - (tw >> 1), py + 10, '#ff3b4f', 'md', sc);
    g.globalAlpha = 1;
    const sub = 'ENGAGED';
    drawText(g, sub, cx - (measure(sub, 'sm') >> 1), py + ph - 12, '#ffb3ba', 'sm');
  }

  // ---------------------------------------------------------------- tooltip

  function tooltipLines(state) {
    if (!hover) return null;
    if (hover.type === 'agent') {
      const a = (state.agents || {})[hover.id];
      if (!a) return null;
      const lines = [
        { text: `${a.name || a.id}`, color: a.palette?.suit || '#ffffff', size: 'md', after: a.title ? ` ${a.title}` : '' },
        { text: statusLabel(a), color: STATUS_COLORS[a.status] || '#ffffff', size: 'md' },
      ];
      if (a.status === 'tool' && a.objectId) lines.push({ text: `AT ${a.objectId}`, color: '#8d97a8', size: 'sm' });
      if (a.detail) for (const l of wrapText(a.detail, 180, 'sm', 3)) lines.push({ text: l, color: '#c7cfdb', size: 'sm' });
      if (a.taskId) lines.push({ text: `TASK ${a.taskId}`, color: '#6f7a8c', size: 'sm' });
      return { lines, border: a.palette?.suit || '#ffffff' };
    }
    if (hover.type === 'object') {
      const o = model.objIndex.get(hover.id);
      if (!o) return null;
      const room = model.rooms[o.room];
      const lines = [{ text: prettyType(o.type), color: mix(room.color, '#ffffff', 0.3), size: 'md' }];
      lines.push({ text: o.id, color: '#6f7a8c', size: 'sm' });
      for (const l of wrapText(`GRANTS ${o.grants.join(' ') || 'NONE'}`, 170, 'sm', 3)) lines.push({ text: l, color: '#aab3c2', size: 'sm' });
      if (o.activeBy) {
        const a = (state.agents || {})[o.activeBy];
        lines.push({ text: `IN USE: ${a?.name || o.activeBy}${o.activeTool ? ` / ${o.activeTool}` : ''}`, color: STATUS_COLORS.tool, size: 'sm' });
      }
      if (o.isGate) {
        if (state.estop) lines.push({ text: 'E-STOP ENGAGED', color: '#ff4d5e', size: 'sm' });
        else if (room.pending) lines.push({ text: 'APPROVAL PENDING IN ROOM', color: '#ffb020', size: 'sm' });
      }
      return { lines, border: room.color };
    }
    return null;
  }

  function buildTooltip(spec) {
    let w = 0;
    let h = 0;
    for (const l of spec.lines) {
      const lw = measure(l.text, l.size) + (l.after ? measure(l.after, 'sm') + 2 : 0);
      w = Math.max(w, lw);
      h += FONTS[l.size].h + 2;
    }
    w += 8;
    h += 6;
    const cv = makeCanvas(w, h);
    const g = cv.getContext('2d');
    g.fillStyle = 'rgba(6,9,15,0.94)';
    g.fillRect(0, 0, w, h);
    outlineRect(g, 0, 0, w, h, spec.border, 1);
    g.fillStyle = spec.border;
    g.fillRect(1, 1, 2, h - 2);
    let y = 3;
    for (const l of spec.lines) {
      const lw = drawText(g, l.text, 5, y, l.color, l.size);
      if (l.after) drawText(g, l.after, 5 + lw + 2, y + 2, '#8d97a8', 'sm');
      y += FONTS[l.size].h + 2;
    }
    return cv;
  }

  function drawTooltip(g, state) {
    if (!hover || hover.type === 'room') return;
    // rebuild only when the hovered thing or the state behind it changed (no per-frame garbage)
    if (!tooltip || tooltip.seq !== state.seq || tooltip.state !== state) {
      const spec = tooltipLines(state);
      tooltip = spec ? { seq: state.seq, state, canvas: buildTooltip(spec) } : { seq: state.seq, state, canvas: null };
    }
    const cv = tooltip.canvas;
    if (!cv) return;
    // visible world rectangle
    const vx0 = Math.max(0, (view.x - offX) / scale);
    const vy0 = Math.max(0, (view.y - offY) / scale);
    const vx1 = Math.min(model.WPX, (view.x + view.w - offX) / scale);
    const vy1 = Math.min(model.HPX, (view.y + view.h - offY) / scale);
    let x = Math.round(hoverWX + 10);
    let y = Math.round(hoverWY - cv.height - 8);
    if (x + cv.width > vx1 - 2) x = Math.round(hoverWX - cv.width - 10);
    if (y < vy0 + 2) y = Math.round(hoverWY + 14);
    x = Math.max(Math.ceil(vx0) + 2, Math.min(x, Math.floor(vx1) - cv.width - 2));
    y = Math.max(Math.ceil(vy0) + 2, Math.min(y, Math.floor(vy1) - cv.height - 2));
    g.drawImage(cv, x, y);
  }

  // ---------------------------------------------------------------- frame

  function sortDrawables() {
    for (const d of drawables) if (d.kind === 1) d.y = d.ref.y;
    drawables.sort(byY);
  }

  function render(now, state) {
    const g = fx;
    const W = model.WPX;
    const H = model.HPX;
    g.fillStyle = SPACE;
    g.fillRect(0, 0, W, H);
    const farOff = Math.floor(now / 2400) % W;
    const nearOff = Math.floor(now / 700) % W;
    g.drawImage(starsFar, -farOff, 0);
    g.drawImage(starsFar, W - farOff, 0);
    g.drawImage(starsNear, -nearOff, 0);
    g.drawImage(starsNear, W - nearOff, 0);
    g.drawImage(staticLayer, 0, 0);
    drawActiveHalls(g, now);
    drawRoomPlates(g, state);
    for (const o of model.objects) {
      if (!o.activeBy) continue;
      const s = o.sprite;
      const room = model.rooms[o.room];
      const pulse = 0.8 + 0.2 * Math.sin(now / 340 + o.i);
      drawHalo(g, o.tx * T + s.left, o.ty * T - OBJECT_OVERHANG + s.top, s.right - s.left, s.bottom - s.top, room.color, pulse);
    }
    sortDrawables();
    const frozen = !!state.estop;
    const focusing = focusT.id && now < focusT.until && focusT.type === 'agent';
    for (const d of drawables) {
      if (d.kind === 0) drawObject(g, d.ref, now, state);
      else {
        const av = d.ref;
        let hl = 0;
        if (hover && hover.type === 'agent' && hover.id === av.id) hl = 0.9;
        if (focusing && focusT.id === av.id) hl = Math.max(hl, ((now / 150) | 0) % 2 ? 1 : 0.4);
        drawAgent(g, av, now, frozen, hl);
      }
    }
    drawOverlays(g, state, now);
    drawPackets(g, now);
    drawHighlights(g, now);
    if (state.estop) drawEstop(g, now);
    drawTooltip(g, state);
  }

  function blit() {
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = SPACE;
    ctx.fillRect(0, 0, bw, bh);
    if (!frame) return;
    const clip = panMode && mini.on && mini.strip;
    if (clip) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(view.x, view.y, view.w, view.h);
      ctx.clip();
    }
    if (sharp) {
      const pw = frame.width * sharp;
      const ph = frame.height * sharp;
      if (!pre || pre.width !== pw || pre.height !== ph) {
        pre = makeCanvas(pw, ph);
        preCtx = pre.getContext('2d', { alpha: false });
      }
      preCtx.imageSmoothingEnabled = false;
      preCtx.drawImage(frame, 0, 0, pw, ph);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(pre, 0, 0, pw, ph, offX, offY, Math.round(frame.width * scale), Math.round(frame.height * scale));
      ctx.imageSmoothingEnabled = false;
    } else {
      ctx.drawImage(frame, 0, 0, frame.width, frame.height, offX, offY, frame.width * scale, frame.height * scale);
    }
    if (clip) ctx.restore();
    if (panMode && mini.on) drawMinimap();
  }

  let raf = 0;
  let lastT = 0;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = lastT ? Math.min(0.1, Math.max(0, (now - lastT) / 1000)) : 0;
    lastT = now;
    const state = client.state;
    if (!state) return;
    if (state.station !== stationRef) rebuild(state.station);
    if (!model) {
      ctx.fillStyle = SPACE;
      ctx.fillRect(0, 0, bw || canvas.width, bh || canvas.height);
      return;
    }
    if (dirty || state !== stateRef || state.seq !== derivedSeq) recomputeDerived(state);
    while (pendingHandoffs.length) spawnPacket(pendingHandoffs.shift(), now);
    if (!state.estop) updateAgents(dt, now);
    updatePackets(dt, now);
    if (panMode && panTargetX !== null) {
      panX += (panTargetX - panX) * Math.min(1, dt * 8);
      panY += (panTargetY - panY) * Math.min(1, dt * 8);
      if (Math.abs(panTargetX - panX) < 1 && Math.abs(panTargetY - panY) < 1) {
        panX = panTargetX;
        panY = panTargetY;
        panTargetX = panTargetY = null;
      }
      applyPan();
    }
    render(now, state);
    blit();
  }

  function start() {
    if (raf || destroyed) return;
    lastT = 0;
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function onVisibility() {
    if (document.hidden) stop();
    else start();
  }

  // ---------------------------------------------------------------- sizing and panning

  // `view` is the part of the backing store that shows the world; in pan mode an overview
  // (`mini`) of the whole station sits either in free space below it or in a corner.
  const view = { x: 0, y: 0, w: 0, h: 0 };
  const mini = { on: false, strip: false, x: 0, y: 0, w: 0, h: 0, smooth: false };

  function worldSize() {
    return model ? [model.WPX, model.HPX] : [56 * T, 33 * T];
  }

  function layout() {
    if (!bw || !bh) return;
    const [WPX, HPX] = worldSize();
    const dpr = window.devicePixelRatio || 1;
    // Keep one world pixel at least ~0.75 CSS px so the pixel font stays legible; when the
    // box cannot fit the whole station at that size, switch to a draggable view + overview.
    const minS = Math.max(1, Math.ceil(dpr * 0.75 - 1e-6));
    const fitF = Math.min(bw / WPX, bh / HPX);
    const fit = Math.floor(fitF);
    view.x = 0;
    view.y = 0;
    view.w = bw;
    view.h = bh;
    mini.on = false;
    sharp = 0;
    if (fit >= minS) {
      panMode = false;
      if (fit / fitF < 0.8) {
        // An integer scale would waste a large part of the box (typical at DPR 1). Fill it
        // with "sharp bilinear": nearest-neighbour prescale to the next integer, then one
        // smooth downscale, so every world pixel keeps the same size (no uneven columns).
        sharp = fit + 1;
        scale = fitF;
      } else scale = fit;
      offX = Math.floor((bw - WPX * scale) / 2);
      offY = Math.floor((bh - HPX * scale) / 2);
    } else {
      scale = minS;
      const wasPan = panMode;
      panMode = true;
      const m = Math.round(6 * dpr);
      // overview strip under the detail view when the box has the height for it
      const stripScale = Math.floor((bw - 2 * m) / WPX);
      let sw = stripScale >= 1 ? WPX * stripScale : bw - 2 * m;
      let sh = stripScale >= 1 ? HPX * stripScale : Math.round((sw * HPX) / WPX);
      if (bh - HPX * scale >= sh + 2 * m && sw > 0) {
        mini.on = true;
        mini.strip = true;
        mini.w = sw;
        mini.h = sh;
        mini.x = Math.floor((bw - sw) / 2);
        mini.y = bh - sh - m;
        mini.smooth = stripScale < 1;
        view.h = mini.y - m;
      } else {
        // corner overlay
        sw = Math.max(48, Math.min(Math.round(bw * 0.28), Math.round(180 * dpr)));
        if (sw >= WPX) sw = WPX * Math.floor(sw / WPX);
        sh = Math.round((sw * HPX) / WPX);
        mini.on = true;
        mini.strip = false;
        mini.w = sw;
        mini.h = sh;
        mini.x = bw - sw - m;
        mini.y = bh - sh - m;
        mini.smooth = sw % WPX !== 0;
      }
      if (!wasPan) {
        panX = view.x + Math.floor((view.w - WPX * scale) / 2);
        panY = view.y + Math.floor((view.h - HPX * scale) / 2);
      }
      applyPan();
    }
    canvas.style.touchAction = panMode ? 'none' : '';
    canvas.style.cursor = panMode ? 'grab' : 'default';
  }

  function clampPan(x, y, out) {
    const [WPX, HPX] = worldSize();
    const ww = WPX * scale;
    const wh = HPX * scale;
    out[0] = ww <= view.w ? view.x + Math.floor((view.w - ww) / 2) : Math.max(view.x + view.w - ww, Math.min(view.x, x));
    out[1] = wh <= view.h ? view.y + Math.floor((view.h - wh) / 2) : Math.max(view.y + view.h - wh, Math.min(view.y, y));
    return out;
  }

  const _pan = [0, 0];

  function applyPan() {
    clampPan(panX, panY, _pan);
    panX = _pan[0];
    panY = _pan[1];
    offX = Math.round(panX);
    offY = Math.round(panY);
  }

  /** Pan so world point (wx, wy) is centred in the view (optionally animated). */
  function centreOn(wx, wy, animate) {
    clampPan(view.x + view.w / 2 - wx * scale, view.y + view.h / 2 - wy * scale, _pan);
    if (animate) {
      panTargetX = _pan[0];
      panTargetY = _pan[1];
    } else {
      panTargetX = panTargetY = null;
      panX = _pan[0];
      panY = _pan[1];
      applyPan();
    }
  }

  function drawMinimap() {
    const [WPX, HPX] = worldSize();
    const dpr = window.devicePixelRatio || 1;
    const b = Math.max(1, Math.round(dpr));
    ctx.fillStyle = mini.strip ? '#1b2333' : 'rgba(4,6,12,0.9)';
    ctx.fillRect(mini.x - b * 2, mini.y - b * 2, mini.w + b * 4, mini.h + b * 4);
    ctx.fillStyle = SPACE;
    ctx.fillRect(mini.x - b, mini.y - b, mini.w + b * 2, mini.h + b * 2);
    ctx.imageSmoothingEnabled = mini.smooth;
    ctx.drawImage(frame, 0, 0, WPX, HPX, mini.x, mini.y, mini.w, mini.h);
    ctx.imageSmoothingEnabled = false;
    // the part of the station the detail view is showing
    const k = mini.w / WPX;
    const x0 = Math.max(0, (view.x - offX) / scale);
    const y0 = Math.max(0, (view.y - offY) / scale);
    const x1 = Math.min(WPX, (view.x + view.w - offX) / scale);
    const y1 = Math.min(HPX, (view.y + view.h - offY) / scale);
    const rx = Math.round(mini.x + x0 * k);
    const ry = Math.round(mini.y + y0 * k);
    const rw = Math.max(b * 3, Math.round((x1 - x0) * k));
    const rh = Math.max(b * 3, Math.round((y1 - y0) * k));
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(rx, ry, rw, rh);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(rx, ry, rw, b);
    ctx.fillRect(rx, ry + rh - b, rw, b);
    ctx.fillRect(rx, ry, b, rh);
    ctx.fillRect(rx + rw - b, ry, b, rh);
  }

  function inMini(bx, by) {
    return panMode && mini.on && bx >= mini.x && by >= mini.y && bx < mini.x + mini.w && by < mini.y + mini.h;
  }

  function panToMini(bx, by) {
    const [WPX, HPX] = worldSize();
    centreOn(((bx - mini.x) / mini.w) * WPX, ((by - mini.y) / mini.h) * HPX, false);
  }

  function resize(w, h) {
    w = Math.max(1, Math.min(16384, Math.round(w)));
    h = Math.max(1, Math.min(16384, Math.round(h)));
    if (w === bw && h === bh) return;
    bw = w;
    bh = h;
    canvas.width = w;
    canvas.height = h;
    ctx.imageSmoothingEnabled = false;
    layout();
    if (model && frame) blit();
  }

  canvas.style.imageRendering = 'pixelated';
  if (!canvas.hasAttribute('role')) canvas.setAttribute('role', 'img');

  const ro = new ResizeObserver((entries) => {
    const e = entries[entries.length - 1];
    const dpr = window.devicePixelRatio || 1;
    // A canvas whose CSS box is not sized by a stylesheet follows its backing store; growing
    // the store to CSS*dpr would then feed back forever. Stop at 1 device px per CSS px.
    if (dpr > 1 && bw && Math.round(e.contentRect.width) === bw && Math.round(e.contentRect.height) === bh) return;
    let w = e.contentRect.width * dpr;
    let h = e.contentRect.height * dpr;
    // Exact device-pixel size when the browser reports one consistent with the DPR (some
    // emulated environments report CSS pixels here, which would halve the resolution).
    const dpb = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
    if (dpb && Math.abs(dpb.inlineSize - w) <= 2 && Math.abs(dpb.blockSize - h) <= 2) {
      w = dpb.inlineSize;
      h = dpb.blockSize;
    }
    resize(w, h);
  });
  try {
    ro.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    ro.observe(canvas);
  }
  {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (r.width && r.height) resize(r.width * dpr, r.height * dpr);
  }

  // ---------------------------------------------------------------- hit testing and pointer input

  /** Client coords -> backing-store pixels. */
  function toBacking(clientX, clientY, out) {
    const r = canvas.getBoundingClientRect();
    out[0] = (clientX - r.left) * (r.width ? canvas.width / r.width : 1);
    out[1] = (clientY - r.top) * (r.height ? canvas.height / r.height : 1);
    return out;
  }

  function inView(bx, by) {
    return bx >= view.x && by >= view.y && bx < view.x + view.w && by < view.y + view.h && !inMini(bx, by);
  }

  function hitTest(wx, wy) {
    if (!model) return null;
    if (wx < 0 || wy < 0 || wx >= model.WPX || wy >= model.HPX) return null;
    // agents, top-most (largest y) first
    let best = null;
    for (const av of agentList) {
      if (!av.present || !av.placed) continue;
      const ax = av.x;
      const ay = av.y;
      if (wx >= ax - 7 && wx < ax + 7 && wy >= ay - 18 && wy < ay + 1) {
        if (!best || av.y > best.y) best = av;
      }
    }
    if (best) return { type: 'agent', id: best.id };
    for (const o of model.objects) {
      const [x, y, w, h] = objectBox(o);
      if (wx >= x && wx < x + w && wy >= y && wy < y + h) return { type: 'object', id: o.id };
    }
    const tx = Math.floor(wx / T);
    const ty = Math.floor(wy / T);
    const ri = model.roomAt[ty * model.W + tx];
    if (ri >= 0) return { type: 'room', id: model.rooms[ri].id };
    return null;
  }

  /** Hit test at client coords (null outside the world view, e.g. over the overview). */
  function hitAt(clientX, clientY) {
    toBacking(clientX, clientY, _b);
    if (!inView(_b[0], _b[1])) return null;
    hoverWX = (_b[0] - offX) / scale;
    hoverWY = (_b[1] - offY) / scale;
    return hitTest(hoverWX, hoverWY);
  }

  const _b = [0, 0];

  function setHover(h) {
    const changed = (h?.type || null) !== (hover?.type || null) || (h?.id || null) !== (hover?.id || null);
    hover = h;
    if (changed) tooltip = null;
    canvas.style.cursor = h ? 'pointer' : panMode ? (pointer.dragging ? 'grabbing' : 'grab') : 'default';
  }

  function onPointerMove(e) {
    if (pointer.down && pointer.id === e.pointerId) {
      if (pointer.mini) {
        toBacking(e.clientX, e.clientY, _b);
        panToMini(_b[0], _b[1]);
        return;
      }
      const dx = e.clientX - pointer.sx;
      const dy = e.clientY - pointer.sy;
      if (!pointer.dragging && Math.abs(dx) + Math.abs(dy) > 5 && panMode) {
        pointer.dragging = true;
        setHover(null);
        canvas.style.cursor = 'grabbing';
      }
      if (pointer.dragging) {
        const r = canvas.getBoundingClientRect();
        const k = r.width ? canvas.width / r.width : 1;
        panTargetX = panTargetY = null;
        panX = pointer.px + dx * k;
        panY = pointer.py + dy * k;
        applyPan();
        return;
      }
    }
    if (e.pointerType === 'touch') return;
    toBacking(e.clientX, e.clientY, _b);
    if (inMini(_b[0], _b[1])) {
      setHover(null);
      canvas.style.cursor = 'pointer';
      return;
    }
    setHover(hitAt(e.clientX, e.clientY));
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    pointer.down = true;
    pointer.id = e.pointerId;
    pointer.sx = e.clientX;
    pointer.sy = e.clientY;
    pointer.px = panX;
    pointer.py = panY;
    pointer.dragging = false;
    toBacking(e.clientX, e.clientY, _b);
    pointer.mini = inMini(_b[0], _b[1]);
    if (pointer.mini) panToMini(_b[0], _b[1]);
    if (panMode) {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  }

  function onPointerUp(e) {
    if (!pointer.down || pointer.id !== e.pointerId) return;
    const wasDrag = pointer.dragging || pointer.mini;
    pointer.down = false;
    pointer.dragging = false;
    pointer.mini = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (wasDrag) {
      canvas.style.cursor = panMode ? 'grab' : 'default';
      return;
    }
    const hit = hitAt(e.clientX, e.clientY);
    if (!hit) return;
    focusT = { id: hit.id, type: hit.type, until: performance.now() + 700 };
    for (const fn of selectFns.slice()) {
      try { fn({ type: hit.type, id: hit.id }); } catch (err) { console.error(err); }
    }
  }

  function onPointerLeave() {
    if (!pointer.dragging) setHover(null);
  }

  function onPointerCancel() {
    pointer.down = false;
    pointer.dragging = false;
    pointer.mini = false;
  }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointercancel', onPointerCancel);
  document.addEventListener('visibilitychange', onVisibility);

  // ---------------------------------------------------------------- events from the client

  const unsubscribe = client.subscribe((event) => {
    dirty = true;
    if (!event) {
      // fresh snapshot: transient effects from before it no longer mean anything
      for (const p of packets) p.active = false;
      for (const f of flashes) f.active = false;
      pendingHandoffs.length = 0;
      return;
    }
    if (event.type === 'handoff' && event.payload && !document.hidden) {
      if (pendingHandoffs.length < MAX_PACKETS) pendingHandoffs.push(event.payload);
    }
  });

  let destroyed = false;
  start();

  return {
    onSelect(fn) {
      if (typeof fn !== 'function') return () => {};
      selectFns.push(fn);
      return () => {
        const i = selectFns.indexOf(fn);
        if (i >= 0) selectFns.splice(i, 1);
      };
    },
    focus(id) {
      if (!model || !id) return;
      let type = null;
      let cx = 0;
      let cy = 0;
      if (agentViz.has(id)) {
        type = 'agent';
        const av = agentViz.get(id);
        cx = av.x;
        cy = av.y - 8;
      } else if (model.roomIndex.has(id)) {
        type = 'room';
        const r = model.roomIndex.get(id);
        cx = (r.x + r.w / 2) * T;
        cy = (r.y + r.h / 2) * T;
      } else if (model.objIndex.has(id)) {
        type = 'object';
        const o = model.objIndex.get(id);
        cx = o.tx * T + T / 2;
        cy = o.ty * T;
      } else return;
      focusT = { id, type, until: performance.now() + FOCUS_MS };
      if (panMode) centreOn(cx, cy, true);
    },
    destroy() {
      destroyed = true;
      stop();
      ro.disconnect();
      unsubscribe?.();
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      document.removeEventListener('visibilitychange', onVisibility);
      selectFns.length = 0;
    },
  };
}

function byY(a, b) {
  return a.y - b.y || a.kind - b.kind;
}
