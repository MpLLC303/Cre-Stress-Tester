// Procedural pixel-art sprites for the station: astronauts, station objects, status bubbles,
// name tags, handoff packets and conveyor chevrons. Everything is drawn with fillRect into
// small offscreen canvases once and blitted with drawImage every frame.
//
// Nothing here knows about runtime state: callers decide WHICH variant to draw (lit or dark,
// lamp colour, bubble) from projector state. These are only the brushes.

import { drawText, measure, FONTS } from './pixelfont.js';

// ---------------------------------------------------------------- colour helpers

export function hexToRgb(hex) {
  let h = String(hex || '#888888').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [136, 136, 136];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear mix of two hex colours: t=0 -> a, t=1 -> b. */
export function mix(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}

export function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Desaturate a colour toward its own luminance (t=1 -> grey). */
export function desaturate(hex, t) {
  const [r, g, b] = hexToRgb(hex);
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  return rgbToHex(r + (l - r) * t, g + (l - g) * t, b + (l - b) * t);
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

// Neutral station metals.
export const METAL = {
  K: '#05070c',
  M1: '#252e3e',
  M2: '#384359',
  M3: '#506079',
  M4: '#71819d',
  M5: '#a6b3c9',
  PAPER: '#e3e9f2',
};

// ---------------------------------------------------------------- astronauts (12x16)

// Upper body (rows 0..12) per facing; legs (rows 13..15) per facing and gait frame.
// o outline, l/s/d/D suit light/base/dark/darker, v/V visor/visor shade, w glint,
// g/G fittings light/dark, b/B backpack.
const UPPER = {
  down: [
    '...oooooo...',
    '..olssssdo..',
    '.olssssssdo.',
    '.olwwvvvvdo.',
    '.oswvvvvVdo.',
    '.osvvvvVVdo.',
    '.ossssssddo.',
    '..odssssdo..',
    '..oggggggo..',
    '.olssssssdo.',
    '.olsggsssdo.',
    '.ogsssssdGo.',
    '..oGggggGo..',
  ],
  up: [
    '...oooooo...',
    '..olssssdo..',
    '.olssssssdo.',
    '.olssssssdo.',
    '.ossssssddo.',
    '.ossssssddo.',
    '.odssssdddo.',
    '..oddddddo..',
    '..oggggggo..',
    '.olbbbbbbdo.',
    '.olbBBBBbdo.',
    '.ogbbbbbbGo.',
    '..oGggggGo..',
  ],
  right: [
    '...oooooo...',
    '..olssssdo..',
    '.olssssssdo.',
    '.olssssvwwo.',
    '.osssssvvVo.',
    '.osssssVVVo.',
    '.ossssssddo.',
    '..odssssdo..',
    '.ooogggggo..',
    '.obbolsssdo.',
    '.obBolssddo.',
    '.obBossgGdo.',
    '..ooogggGo..',
  ],
};

const LEGS = {
  down: {
    stand: ['..osssssdo..', '..osdoosdo..', '..oggoogGo..'],
    a: ['..osssssdo..', '..osdoogGo..', '..oggo......'],
    b: ['..osssssdo..', '..oggoosdo..', '......ogGo..'],
  },
  right: {
    stand: ['....osssdo..', '....osddo...', '....oggGGo..'],
    a: ['....osssdo..', '...osdoosdo.', '..oggo.ogGGo'],
    b: ['....osssdo..', '....osddo...', '....oggGGo..'],
  },
};
LEGS.up = LEGS.down;

export const FACING = { down: 0, up: 1, right: 2, left: 3 };
export const AGENT_CELL_W = 14; // 12px sprite + 1px outline margin each side
export const AGENT_CELL_H = 18;

function agentColors(palette) {
  const suit = palette?.suit || '#9aa6bb';
  const visor = palette?.visor || '#e6f2ff';
  return {
    o: mix(suit, '#04060b', 0.8),
    l: mix(suit, '#ffffff', 0.38),
    s: suit,
    d: mix(suit, '#000000', 0.3),
    D: mix(suit, '#000000', 0.52),
    v: visor,
    V: mix(visor, '#34405a', 0.5),
    w: '#ffffff',
    g: '#d6dce6',
    G: '#7f8a9e',
    b: mix(suit, '#2a3242', 0.6),
    B: mix(suit, '#121722', 0.72),
  };
}

function spriteRows(facing, frame) {
  const base = facing === 'left' ? 'right' : facing;
  const upper = UPPER[base];
  const legs = LEGS[base][frame === 2 ? 'a' : frame === 3 ? 'b' : 'stand'];
  const rows = new Array(16).fill('............');
  if (frame === 1) {
    // breathing: legs stay planted, the upper body settles one pixel over the hips
    for (let r = 0; r < 13; r++) rows[r + 1] = upper[r];
    rows[14] = legs[1];
    rows[15] = legs[2];
  } else {
    for (let r = 0; r < 13; r++) rows[r] = upper[r];
    rows[13] = legs[0];
    rows[14] = legs[1];
    rows[15] = legs[2];
  }
  return facing === 'left' ? rows.map((r) => r.split('').reverse().join('')) : rows;
}

/**
 * Build a sprite sheet for one astronaut palette.
 * Layout: columns = frame (0 stand, 1 breathe, 2 walkA, 3 walkB); rows = facing (down, up, right, left).
 * Each cell is AGENT_CELL_W x AGENT_CELL_H with the 12x16 sprite at (1,1).
 * Returns { sheet, outline } where `outline` holds a 1px white silhouette ring for hover/focus.
 */
export function makeAgentSheet(palette) {
  const colors = agentColors(palette);
  const facings = ['down', 'up', 'right', 'left'];
  const sheet = makeCanvas(AGENT_CELL_W * 4, AGENT_CELL_H * 4);
  const outline = makeCanvas(AGENT_CELL_W * 4, AGENT_CELL_H * 4);
  const g = sheet.getContext('2d');
  const go = outline.getContext('2d');
  go.fillStyle = '#ffffff';
  for (let fi = 0; fi < 4; fi++) {
    for (let frame = 0; frame < 4; frame++) {
      const rows = spriteRows(facings[fi], frame);
      const ox = frame * AGENT_CELL_W + 1;
      const oy = fi * AGENT_CELL_H + 1;
      const solid = new Uint8Array(AGENT_CELL_W * AGENT_CELL_H);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 12; x++) {
          const ch = rows[y][x];
          if (ch === '.') continue;
          g.fillStyle = colors[ch] || colors.s;
          g.fillRect(ox + x, oy + y, 1, 1);
          solid[(y + 1) * AGENT_CELL_W + (x + 1)] = 1;
        }
      }
      for (let y = 0; y < AGENT_CELL_H; y++) {
        for (let x = 0; x < AGENT_CELL_W; x++) {
          if (solid[y * AGENT_CELL_W + x]) continue;
          let near = false;
          for (let dy = -1; dy <= 1 && !near; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
              const nx = x + dx;
              const ny = y + dy;
              if (nx >= 0 && ny >= 0 && nx < AGENT_CELL_W && ny < AGENT_CELL_H && solid[ny * AGENT_CELL_W + nx]) {
                near = true;
                break;
              }
            }
          }
          if (near) go.fillRect(frame * AGENT_CELL_W + x, fi * AGENT_CELL_H + y, 1, 1);
        }
      }
    }
  }
  return { sheet, outline };
}

// ---------------------------------------------------------------- station objects

export const OBJECT_W = 16;
export const OBJECT_H = 24; // 16px footprint + 8px of height above the tile
export const OBJECT_OVERHANG = 8;

function objectPalette(roomColor) {
  const R = roomColor || '#8899aa';
  return {
    R,
    RL: mix(R, '#ffffff', 0.45),
    RD: mix(R, '#000000', 0.5),
    RDD: mix(R, '#05070c', 0.75),
    scrOff: mix('#070d12', R, 0.16),
    scrOffLine: mix('#070d12', R, 0.32),
    scrOn: mix(R, '#0a1018', 0.35),
    scrHi: mix(R, '#ffffff', 0.55),
  };
}

// mode: 0 = dark/idle, 1 = in use, 2 = in use (alternate flicker frame)
const OBJECT_DRAW = {
  command_console(P, c, mode, M) {
    P(2, -7, 12, 10, M.K);
    P(3, -6, 10, 8, M.M2);
    P(3, -6, 10, 1, M.M3);
    P(4, -5, 8, 6, mode ? c.scrOn : c.scrOff);
    if (mode) {
      P(5, -4, mode === 1 ? 5 : 3, 1, c.scrHi);
      P(5, -2, mode === 1 ? 3 : 5, 1, c.RL);
      P(9, -1, 2, 1, c.scrHi);
      P(5, 0, 2, 1, c.RL);
    } else {
      P(5, -4, 4, 1, c.scrOffLine);
      P(5, -2, 3, 1, c.scrOffLine);
    }
    P(7, 3, 2, 1, M.M1);
    // curved desk seen from above
    P(1, 4, 14, 1, M.K);
    P(0, 5, 16, 4, M.K);
    P(1, 5, 14, 1, M.M5);
    P(1, 6, 14, 2, M.M3);
    P(3, 6, 1, 1, c.RD);
    P(5, 6, 2, 1, M.M4);
    P(9, 6, 2, 1, M.M4);
    P(12, 6, 1, 1, c.RD);
    P(1, 8, 14, 1, M.M2);
    P(2, 9, 12, 3, M.M1);
    P(2, 9, 12, 1, M.M2);
    P(5, 10, 1, 2, M.K);
    P(10, 10, 1, 2, M.K);
    P(3, 12, 10, 1, M.K);
  },
  status_board(P, c, mode, M) {
    P(1, -8, 14, 13, M.K);
    P(2, -7, 12, 11, M.M2);
    P(2, -7, 12, 1, M.M3);
    P(3, -6, 10, 9, mode ? c.scrOn : c.scrOff);
    const line = mode ? c.RL : c.scrOffLine;
    for (let i = 0; i < 4; i++) P(4, -5 + i * 2, i % 2 ? 5 : 7, 1, line);
    if (mode) P(4, -5 + (mode === 1 ? 2 : 4), 8, 1, c.scrHi);
    P(4, 5, 1, 7, M.M1);
    P(11, 5, 1, 7, M.M1);
    P(3, 12, 3, 1, M.M3);
    P(10, 12, 3, 1, M.M3);
  },
  research_terminal(P, c, mode, M) {
    // antenna
    P(12, -8, 1, 1, mode ? c.scrHi : c.RD);
    P(12, -7, 1, 11, M.M4);
    P(10, -5, 5, 1, M.M5);
    P(11, -4, 3, 1, M.M3);
    // monitor
    P(0, -3, 11, 9, M.K);
    P(1, -2, 9, 7, M.M2);
    P(1, -2, 9, 1, M.M3);
    P(2, -1, 7, 5, mode ? c.scrOn : c.scrOff);
    if (mode) {
      const wave = mode === 1 ? [2, 1, 0, 1, 2, 3, 2] : [1, 0, 1, 2, 3, 2, 1];
      for (let i = 0; i < 7; i++) P(2 + i, -1 + wave[i] + 1, 1, 1, c.scrHi);
    } else {
      P(3, 1, 5, 1, c.scrOffLine);
    }
    // desk
    P(0, 6, 16, 1, M.K);
    P(0, 7, 16, 1, M.M5);
    P(0, 8, 16, 1, M.M3);
    P(1, 9, 14, 3, M.M1);
    P(1, 12, 14, 1, M.K);
    P(3, 7, 6, 1, M.M2);
  },
  workbench(P, c, mode, M) {
    // tools on the top
    P(1, 0, 4, 3, M.M4); // vise
    P(2, -1, 2, 1, M.M5);
    P(6, 1, 4, 3, M.K); // tablet
    P(7, 2, 2, 1, mode ? c.scrHi : c.scrOffLine);
    P(10, -1, 5, 4, c.RD); // parts bin
    P(10, -1, 5, 1, c.R);
    P(11, 0, 1, 1, M.M5);
    P(13, 1, 1, 1, M.M5);
    // bench
    P(0, 3, 16, 1, M.K);
    P(0, 4, 16, 1, M.M5);
    P(0, 5, 16, 2, M.M3);
    P(2, 5, 6, 1, M.M4); // wrench
    P(8, 5, 1, 1, M.M5);
    P(0, 7, 16, 1, M.K);
    P(1, 8, 2, 5, M.M2);
    P(13, 8, 2, 5, M.M2);
    P(3, 10, 10, 1, M.M1);
    P(4, 9, 3, 1, c.RDD);
  },
  archive(P, c, mode, M) {
    P(1, -8, 14, 21, M.K);
    P(2, -7, 12, 19, M.M2);
    P(2, -7, 12, 1, M.M4);
    const spines = [c.R, M.M4, c.RD, '#b8a27c', M.M5, c.RL, M.M3, '#7d8fb0'];
    for (let s = 0; s < 3; s++) {
      const y = -5 + s * 6;
      P(3, y, 10, 5, M.M1);
      let x = 3;
      let k = s * 3;
      while (x < 12) {
        const w = (k % 3) === 1 ? 2 : 1;
        P(x, y + ((k % 4) === 0 ? 1 : 0), w, 5 - ((k % 4) === 0 ? 1 : 0), spines[k % spines.length]);
        x += w + ((k % 5) === 2 ? 1 : 0);
        k++;
      }
      P(2, y + 5, 12, 1, M.M3);
    }
    P(12, -7, 1, 1, mode ? (mode === 1 ? c.scrHi : c.R) : M.M1);
    P(2, 12, 12, 1, M.K);
  },
  design_station(P, c, mode, M) {
    // easel legs
    for (let i = 0; i < 9; i++) {
      P(4 - (i >> 2), 4 + i, 1, 1, M.M3);
      P(11 + (i >> 2), 4 + i, 1, 1, M.M3);
    }
    P(7, 4, 2, 9, M.M1);
    // canvas
    P(2, -8, 12, 12, M.K);
    P(3, -7, 10, 10, M.PAPER);
    if (mode) {
      P(5, -6, 6, 1, c.R);
      P(4, -5, 8, 3, c.R);
      P(5, -2, 6, 1, c.RD);
      P(6, -4, 4, 1, c.scrHi);
      P(4, 0, mode === 1 ? 6 : 4, 1, M.M4);
      P(4, 1, mode === 1 ? 3 : 5, 1, c.RD);
    } else {
      P(5, -5, 6, 1, '#b7c0cd');
      P(4, -3, 8, 1, '#c7cfda');
      P(5, -1, 5, 1, '#c7cfda');
    }
    P(2, 4, 12, 1, M.M4);
    P(2, 5, 12, 1, M.K);
  },
  listing_composer(P, c, mode, M) {
    // screen on the back of the desk
    P(9, -4, 6, 6, M.K);
    P(10, -3, 4, 3, mode ? c.scrOn : c.scrOff);
    if (mode) P(10, mode === 1 ? -3 : -2, 3, 1, c.scrHi);
    // desk top
    P(0, 1, 16, 1, M.K);
    P(0, 2, 16, 5, M.M3);
    P(0, 2, 16, 1, M.M5);
    // paper + stylus
    P(2, 3, 6, 4, M.PAPER);
    P(3, 4, 4, 1, '#98a2b3');
    P(3, 5, 3, 1, mode ? c.R : '#98a2b3');
    P(9, 4, 4, 1, M.M1);
    P(13, 4, 1, 1, c.R);
    // front
    P(0, 7, 16, 1, M.K);
    P(1, 8, 14, 4, M.M1);
    P(7, 9, 2, 1, M.M3);
    P(1, 12, 14, 1, M.K);
  },
  publish_gate(P, c, mode, M) {
    gate(P, c, mode, M, 'publish');
  },
  delivery_gate(P, c, mode, M) {
    gate(P, c, mode, M, 'delivery');
  },
  packager(P, c, mode, M) {
    // conveyor
    P(0, 5, 16, 7, M.K);
    P(0, 6, 16, 1, M.M4);
    P(0, 7, 16, 3, M.M1);
    const shift = mode === 2 ? 1 : 0;
    for (let x = shift; x < 16; x += 3) P(x, 8, 1, 1, mode ? c.RD : M.M3);
    P(0, 10, 16, 1, M.M2);
    P(1, 12, 2, 1, M.M2);
    P(13, 12, 2, 1, M.M2);
    // crate
    P(4, -3, 8, 9, M.K);
    P(5, -2, 6, 7, '#9c7448');
    P(5, -2, 6, 1, '#c39661');
    P(5, 1, 6, 1, '#7a5634');
    P(7, -2, 2, 7, c.RD);
    P(7, -2, 2, 1, c.R);
  },
  ledger_terminal(P, c, mode, M, g) {
    P(1, -7, 14, 11, M.K);
    P(2, -6, 12, 9, M.M2);
    P(2, -6, 12, 1, M.M3);
    P(3, -5, 10, 7, mode ? c.scrOn : c.scrOff);
    drawText(g, '$', 6, -5 + OBJECT_OVERHANG, mode ? (mode === 1 ? c.scrHi : c.RL) : c.scrOffLine, 'md');
    P(7, 4, 2, 2, M.M1);
    P(0, 6, 16, 1, M.K);
    P(0, 7, 16, 1, M.M5);
    P(0, 8, 16, 1, M.M3);
    P(1, 9, 14, 3, M.M1);
    P(1, 12, 14, 1, M.K);
  },
  connector_dock(P, c, mode, M) {
    P(2, -7, 12, 12, M.K);
    P(3, -6, 10, 10, M.M2);
    P(3, -6, 10, 1, M.M4);
    P(5, -4, 6, 5, M.K);
    P(6, -3, 4, 3, mode ? (mode === 1 ? c.scrHi : c.R) : c.RDD);
    P(7, -2, 2, 1, mode ? c.RL : c.RD);
    P(4, 2, 8, 1, c.RD);
    P(3, 5, 10, 2, M.M1);
    // cable to the floor
    const cable = '#0d1118';
    P(8, 1, 1, 4, cable);
    P(9, 6, 1, 2, cable);
    P(10, 8, 2, 1, cable);
    P(12, 9, 1, 2, cable);
    P(11, 11, 3, 2, M.M4);
    P(11, 11, 3, 1, M.M5);
  },
};

function gate(P, c, mode, M, kind) {
  // field between the pillars
  P(4, -4, 8, 16, mix('#05080d', c.R, 0.08));
  if (mode) {
    for (let y = -4 + (mode === 2 ? 1 : 0); y < 12; y += 3) P(4, y, 8, 1, c.RD);
    P(4, mode === 1 ? 2 : 6, 8, 1, c.RL);
  }
  // icon in the field: publish = up arrow, delivery = parcel
  const icon = mode ? c.RL : mix(M.M2, c.R, 0.25);
  if (kind === 'publish') {
    P(7, 0, 2, 6, icon);
    P(6, 1, 4, 1, icon);
    P(5, 2, 1, 1, icon);
    P(10, 2, 1, 1, icon);
  } else {
    P(5, 1, 6, 5, icon);
    P(5, 1, 6, 1, mix(icon, '#ffffff', 0.3));
    P(7, 1, 2, 5, mix(icon, '#000000', 0.35));
  }
  // pillars
  P(0, -6, 4, 19, M.K);
  P(1, -5, 2, 17, M.M3);
  P(1, -5, 1, 17, M.M4);
  P(12, -6, 4, 19, M.K);
  P(13, -5, 2, 17, M.M3);
  P(14, -5, 1, 17, M.M2);
  // beam + lamp housing (lamp itself is drawn live by the world)
  P(0, -8, 16, 4, M.K);
  P(1, -7, 14, 2, M.M3);
  P(1, -7, 14, 1, M.M4);
  P(6, -8, 4, 4, M.K);
  // hazard threshold
  P(3, 12, 10, 1, M.M1);
  for (let x = 3; x < 13; x += 2) P(x, 12, 1, 1, '#8a6d1f');
}

/** Lamp position (tile-local, y relative to the tile top) for gate objects, else null. */
export function objectLamp(type) {
  return type === 'publish_gate' || type === 'delivery_gate' ? { x: 7, y: -7, w: 2, h: 2 } : null;
}

/**
 * Pre-render one station object. Returns
 * { frames: [dark, lit, litAlt], top, bottom, left, right } where frames are OBJECT_W x OBJECT_H canvases
 * meant to be drawn at (tileX*16, tileY*16 - OBJECT_OVERHANG); the bounds are the opaque pixel box
 * in that canvas (for hit testing and halos).
 */
export function makeObjectSprite(type, roomColor) {
  const c = objectPalette(roomColor);
  const draw = OBJECT_DRAW[type] || genericObject;
  const frames = [];
  for (let mode = 0; mode < 3; mode++) {
    const cv = makeCanvas(OBJECT_W, OBJECT_H);
    const g = cv.getContext('2d');
    const P = (x, y, w, h, col) => {
      g.fillStyle = col;
      g.fillRect(x, y + OBJECT_OVERHANG, w, h);
    };
    // contact shadow
    g.fillStyle = 'rgba(0,0,0,0.38)';
    g.fillRect(1, 13 + OBJECT_OVERHANG, 14, 2);
    draw(P, c, mode, METAL, g);
    frames.push(cv);
  }
  // opaque bounds of the dark frame
  const data = frames[0].getContext('2d').getImageData(0, 0, OBJECT_W, OBJECT_H).data;
  let top = OBJECT_H;
  let bottom = 0;
  let left = OBJECT_W;
  let right = 0;
  for (let y = 0; y < OBJECT_H; y++) {
    for (let x = 0; x < OBJECT_W; x++) {
      if (data[(y * OBJECT_W + x) * 4 + 3] > 200) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  return { frames, top, bottom: bottom + 1, left, right: right + 1 };
}

function genericObject(P, c, mode, M) {
  P(2, -2, 12, 14, M.K);
  P(3, -1, 10, 12, M.M2);
  P(5, 1, 6, 4, mode ? c.scrOn : c.scrOff);
  if (mode) P(6, 2, 3, 1, c.scrHi);
}

// ---------------------------------------------------------------- bubbles and tags

export const STATUS_COLORS = {
  idle: '#7d8798',
  thinking: '#8fdcff',
  tool: '#6dffa8',
  awaiting_approval: '#ff4d5e',
  handoff: '#c9a8ff',
  error: '#ff4d5e',
  paused: '#a7afbd',
};

/**
 * Speech-bubble canvas around an inner content painter, with its tail at the bottom-left
 * (the bubble sits to the upper-right of a helmet). Returns { canvas, w, h }; the tail tip
 * is at (0, h-1).
 */
function bubbleCanvas(innerW, innerH, { bg, border }, paint) {
  const w = innerW + 4 + 2;
  const h = innerH + 4 + 2; // 2px tail
  const cv = makeCanvas(w, h);
  const g = cv.getContext('2d');
  const bx = 2;
  const bw = w - 2;
  const bh = h - 2;
  g.fillStyle = border;
  g.fillRect(bx + 1, 0, bw - 2, 1);
  g.fillRect(bx + 1, bh - 1, bw - 2, 1);
  g.fillRect(bx, 1, 1, bh - 2);
  g.fillRect(bx + bw - 1, 1, 1, bh - 2);
  g.fillStyle = bg;
  g.fillRect(bx + 1, 1, bw - 2, bh - 2);
  // tail toward the lower-left
  g.fillStyle = border;
  g.fillRect(bx, bh - 2, 1, 2);
  g.fillRect(1, bh - 1, 2, 1);
  g.fillRect(0, bh, 2, 1);
  g.fillRect(0, bh + 1, 1, 1);
  g.fillStyle = bg;
  g.fillRect(bx + 1, bh - 2, 1, 1);
  paint(g, bx + 2, 2);
  return { canvas: cv, w, h };
}

/** '...' thinking bubble; `dots` = 1..3 visible dots. */
export function makeThinkingBubble(dots) {
  return bubbleCanvas(9, 5, { bg: '#e9eef6', border: '#0b0f18' }, (g, x, y) => {
    g.fillStyle = '#2b3445';
    for (let i = 0; i < 3; i++) {
      g.fillStyle = i < dots ? '#1d2534' : '#c3cad6';
      g.fillRect(x + i * 4, y + 2, 1, 2);
      g.fillRect(x + i * 4, y + 3, 2, 1);
      g.fillRect(x + i * 4 + 1, y + 2, 1, 1);
    }
  });
}

/** Tool bubble: up to three letters of the tool name. */
export function makeToolBubble(abbrev) {
  const text = String(abbrev || '?').toUpperCase().slice(0, 3);
  const tw = measure(text, 'sm');
  return bubbleCanvas(Math.max(tw, 7), 5, { bg: '#e9eef6', border: '#0b0f18' }, (g, x, y) => {
    drawText(g, text, x + ((Math.max(tw, 7) - tw) >> 1), y, '#0f3a24', 'sm');
  });
}

/** Awaiting approval: red '!' bubble. `bright` toggles the pulse frame. */
export function makeApprovalBubble(bright) {
  return bubbleCanvas(3, 7, { bg: bright ? '#ff3b4f' : '#b3202f', border: '#1a0306' }, (g, x, y) => {
    g.fillStyle = '#ffffff';
    g.fillRect(x + 1, y, 2, 5);
    g.fillRect(x + 1, y + 6, 2, 1);
  });
}

export function makeErrorBubble() {
  return bubbleCanvas(5, 5, { bg: '#2a0a10', border: '#ff4d5e' }, (g, x, y) => {
    g.fillStyle = '#ff6b78';
    for (let i = 0; i < 5; i++) {
      g.fillRect(x + i, y + i, 1, 1);
      g.fillRect(x + 4 - i, y + i, 1, 1);
    }
  });
}

export function makePausedBubble() {
  return bubbleCanvas(5, 5, { bg: '#c3c9d4', border: '#0b0f18' }, (g, x, y) => {
    g.fillStyle = '#3a4252';
    g.fillRect(x + 1, y, 1, 5);
    g.fillRect(x + 3, y, 1, 5);
  });
}

export function makeHandoffBubble() {
  return bubbleCanvas(7, 5, { bg: '#e9eef6', border: '#0b0f18' }, (g, x, y) => {
    drawText(g, '>>', x, y, '#4b2a8a', 'sm');
  });
}

/**
 * Name tag: dark plate, name in the md face, optional status suffix in the sm face.
 * Returns { canvas, w, h }.
 */
export function makeNameTag(name, { color = '#e8eef8', accent = null, suffix = '', suffixColor = '#8a93a3', dim = false } = {}) {
  const text = String(name || '?').toUpperCase();
  const nameW = measure(text, 'md');
  const sufW = suffix ? measure(suffix, 'sm') + 3 : 0;
  const w = nameW + sufW + 4;
  const h = FONTS.md.h + 4;
  const cv = makeCanvas(w, h + (accent ? 1 : 0));
  const g = cv.getContext('2d');
  g.fillStyle = dim ? 'rgba(6,9,15,0.62)' : 'rgba(6,9,15,0.82)';
  g.fillRect(1, 0, w - 2, h);
  g.fillRect(0, 1, w, h - 2);
  drawText(g, text, 2, 2, color, 'md');
  if (suffix) drawText(g, suffix, 2 + nameW + 3, 4, suffixColor, 'sm');
  if (accent) {
    g.fillStyle = accent;
    g.fillRect(2, h, nameW, 1);
  }
  return { canvas: cv, w, h: h + (accent ? 1 : 0) };
}

/** Small numeric badge (artifact counts). */
export function makeBadge(text, bg = '#0b0f18', fg = '#ffffff') {
  const t = String(text);
  const w = measure(t, 'sm') + 4;
  const cv = makeCanvas(w, 9);
  const g = cv.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(1, 0, w - 2, 9);
  g.fillRect(0, 1, w, 7);
  drawText(g, t, 2, 2, fg, 'sm');
  return { canvas: cv, w, h: 9 };
}

// ---------------------------------------------------------------- packets and conveyors

/** Glowing data cube (7x7) in a room colour. */
export function makePacketSprite(color) {
  const cv = makeCanvas(7, 7);
  const g = cv.getContext('2d');
  const P = (x, y, w, h, col) => {
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
  };
  P(1, 0, 5, 7, '#04060b');
  P(0, 1, 7, 5, '#04060b');
  P(1, 1, 5, 5, color);
  P(1, 1, 5, 2, mix(color, '#ffffff', 0.55));
  P(1, 1, 2, 1, '#ffffff');
  P(4, 3, 2, 3, mix(color, '#000000', 0.3));
  P(1, 5, 3, 1, mix(color, '#000000', 0.15));
  return cv;
}

// Chevron 4 (along) x 7 (across), pointing right.
const CHEVRON = ['x...', 'xx..', '.xx.', '..xx', '.xx.', 'xx..', 'x...'];

/** Chevron sprites for the four travel directions: [right, down, left, up]. */
export function makeChevrons(color) {
  const out = [];
  for (let dir = 0; dir < 4; dir++) {
    const horizontal = dir === 0 || dir === 2;
    const cv = makeCanvas(horizontal ? 4 : 7, horizontal ? 7 : 4);
    const g = cv.getContext('2d');
    g.fillStyle = color;
    for (let r = 0; r < 7; r++) {
      for (let a = 0; a < 4; a++) {
        if (CHEVRON[r][a] !== 'x') continue;
        if (dir === 0) g.fillRect(a, r, 1, 1);
        else if (dir === 2) g.fillRect(3 - a, r, 1, 1);
        else if (dir === 1) g.fillRect(r, a, 1, 1);
        else g.fillRect(r, 3 - a, 1, 1);
      }
    }
    out.push(cv);
  }
  return out;
}
