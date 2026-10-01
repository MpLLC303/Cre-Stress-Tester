// Procedural bitmap fonts for the station canvas, drawn with fillRect (no web fonts, no network).
//
// Two faces:
//   'md'  5x7  - room names, name tags, tooltips
//   'sm'  3x5  - counts, bubble abbreviations, badges
//
// Glyph rows are bit masks, most significant bit = leftmost column. Glyphs are proportional:
// empty columns are trimmed and one column of spacing is added between characters.
// Text is upper-cased; characters without a glyph render as '?'.

const MD_SRC = {
  A: [0x0e, 0x11, 0x11, 0x11, 0x1f, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  '.': [0, 0, 0, 0, 0, 0x01, 0x01],
  ',': [0, 0, 0, 0, 0, 0x01, 0x02],
  ':': [0, 0x01, 0x01, 0, 0x01, 0x01, 0],
  ';': [0, 0x01, 0x01, 0, 0x01, 0x01, 0x02],
  '-': [0, 0, 0, 0x0f, 0, 0, 0],
  '/': [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
  '!': [0x01, 0x01, 0x01, 0x01, 0x01, 0, 0x01],
  '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0, 0x04],
  $: [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04],
  '%': [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
  '#': [0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a],
  '(': [0x01, 0x02, 0x04, 0x04, 0x04, 0x02, 0x01],
  ')': [0x04, 0x02, 0x01, 0x01, 0x01, 0x02, 0x04],
  '[': [0x07, 0x04, 0x04, 0x04, 0x04, 0x04, 0x07],
  ']': [0x07, 0x01, 0x01, 0x01, 0x01, 0x01, 0x07],
  '+': [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
  '=': [0, 0, 0x1f, 0, 0x1f, 0, 0],
  '*': [0, 0x04, 0x15, 0x0e, 0x15, 0x04, 0],
  "'": [0x01, 0x01, 0x02, 0, 0, 0, 0],
  '"': [0x05, 0x05, 0x0a, 0, 0, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 0x1f],
  '>': [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
  '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  '@': [0x0e, 0x11, 0x01, 0x0d, 0x15, 0x15, 0x0e],
  '&': [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d],
  '·': [0, 0, 0, 0x01, 0, 0, 0],
};

const SM_SRC = {
  A: [2, 5, 7, 5, 5],
  B: [6, 5, 6, 5, 6],
  C: [3, 4, 4, 4, 3],
  D: [6, 5, 5, 5, 6],
  E: [7, 4, 6, 4, 7],
  F: [7, 4, 6, 4, 4],
  G: [3, 4, 5, 5, 3],
  H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7],
  J: [1, 1, 1, 5, 2],
  K: [5, 5, 6, 5, 5],
  L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5],
  N: [6, 5, 5, 5, 5],
  O: [2, 5, 5, 5, 2],
  P: [6, 5, 6, 4, 4],
  Q: [2, 5, 5, 6, 3],
  R: [6, 5, 6, 5, 5],
  S: [3, 4, 2, 1, 6],
  T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7],
  V: [5, 5, 5, 5, 2],
  W: [5, 5, 7, 7, 5],
  X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2],
  Z: [7, 1, 2, 4, 7],
  0: [7, 5, 5, 5, 7],
  1: [2, 6, 2, 2, 7],
  2: [6, 1, 2, 4, 7],
  3: [6, 1, 2, 1, 6],
  4: [5, 5, 7, 1, 1],
  5: [7, 4, 6, 1, 6],
  6: [3, 4, 6, 5, 2],
  7: [7, 1, 2, 2, 2],
  8: [2, 5, 2, 5, 2],
  9: [2, 5, 3, 1, 6],
  '.': [0, 0, 0, 0, 1],
  ',': [0, 0, 0, 1, 2],
  ':': [0, 1, 0, 1, 0],
  ';': [0, 1, 0, 1, 2],
  '-': [0, 0, 7, 0, 0],
  '/': [1, 1, 2, 4, 4],
  '!': [1, 1, 1, 0, 1],
  '?': [6, 1, 2, 0, 2],
  $: [3, 6, 2, 3, 6],
  '%': [5, 1, 2, 4, 5],
  '#': [5, 7, 5, 7, 5],
  '(': [1, 2, 2, 2, 1],
  ')': [2, 1, 1, 1, 2],
  '[': [3, 2, 2, 2, 3],
  ']': [3, 1, 1, 1, 3],
  '+': [0, 2, 7, 2, 0],
  '=': [0, 7, 0, 7, 0],
  '*': [0, 5, 2, 5, 0],
  "'": [1, 1, 0, 0, 0],
  '"': [5, 5, 0, 0, 0],
  _: [0, 0, 0, 0, 7],
  '>': [4, 2, 1, 2, 4],
  '<': [1, 2, 4, 2, 1],
  '@': [2, 5, 7, 4, 3],
  '&': [2, 5, 2, 5, 3],
  '·': [0, 0, 1, 0, 0],
};

// Characters that have no glyph of their own but a close stand-in.
const ALIASES = { '→': '>', '←': '<', '…': '.', '×': 'X', '✕': 'X', '—': '-', '–': '-', '•': '·', '|': 'I', '`': "'", '~': '-', '^': "'", '{': '(', '}': ')', '\\': '/' };

function buildFace(src, cols, rows, spaceAdvance) {
  const glyphs = new Map();
  for (const ch of Object.keys(src)) {
    const bits = src[ch];
    let minC = cols;
    let maxC = -1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (bits[r] & (1 << (cols - 1 - c))) {
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }
    const runs = []; // flat [row, col, len, ...] relative to the trimmed left edge
    for (let r = 0; r < rows; r++) {
      let c = 0;
      while (c < cols) {
        if (bits[r] & (1 << (cols - 1 - c))) {
          const start = c;
          while (c < cols && bits[r] & (1 << (cols - 1 - c))) c++;
          runs.push(r, start - minC, c - start);
        } else c++;
      }
    }
    glyphs.set(ch.codePointAt(0), { runs: Int8Array.from(runs), width: maxC < 0 ? 1 : maxC - minC + 1 });
  }
  const space = { runs: new Int8Array(0), width: spaceAdvance - 1 };
  glyphs.set(32, space);
  const fallback = glyphs.get(63); // '?'
  // Fast table for ASCII; lowercase folds to uppercase.
  const ascii = new Array(128).fill(null);
  for (let code = 0; code < 128; code++) {
    let g = glyphs.get(code);
    if (!g && code >= 97 && code <= 122) g = glyphs.get(code - 32);
    if (!g && ALIASES[String.fromCharCode(code)]) g = glyphs.get(ALIASES[String.fromCharCode(code)].codePointAt(0));
    ascii[code] = g || (code < 32 ? space : fallback);
  }
  for (const [from, to] of Object.entries(ALIASES)) {
    const code = from.codePointAt(0);
    if (code >= 128 && !glyphs.has(code)) glyphs.set(code, glyphs.get(to.codePointAt(0)) || fallback);
  }
  return { h: rows, ascii, glyphs, fallback };
}

export const FONTS = {
  md: buildFace(MD_SRC, 5, 7, 4),
  sm: buildFace(SM_SRC, 3, 5, 3),
};

function glyphFor(face, code) {
  if (code < 128) return face.ascii[code];
  return face.glyphs.get(code) || face.fallback;
}

/** Pixel height of a face. */
export function textHeight(size = 'md') {
  return FONTS[size].h;
}

/** Width in pixels of `text` rendered in `size` (no trailing spacing). */
export function measure(text, size = 'md', scale = 1) {
  const face = FONTS[size];
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const g = glyphFor(face, text.charCodeAt(i));
    w += g.width + 1;
  }
  return w > 0 ? (w - 1) * scale : 0;
}

/**
 * Draw `text` at integer (x, y) (top-left) with fillRect. Returns the drawn width.
 * Allocation-free: safe to call every frame.
 */
export function drawText(ctx, text, x, y, color, size = 'md', scale = 1) {
  const face = FONTS[size];
  ctx.fillStyle = color;
  let cx = x;
  for (let i = 0; i < text.length; i++) {
    const g = glyphFor(face, text.charCodeAt(i));
    const runs = g.runs;
    for (let k = 0; k < runs.length; k += 3) {
      ctx.fillRect(cx + runs[k + 1] * scale, y + runs[k] * scale, runs[k + 2] * scale, scale);
    }
    cx += (g.width + 1) * scale;
  }
  return cx - x - (text.length ? scale : 0);
}

/** Truncate `text` with '..' so it fits `maxWidth` pixels. */
export function fitText(text, maxWidth, size = 'md') {
  if (measure(text, size) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${text.slice(0, mid)}..`, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}..`;
}

/** Greedy word wrap into lines no wider than `maxWidth`; at most `maxLines` (last line truncated). */
export function wrapText(text, maxWidth, size = 'md', maxLines = 3) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    let word = words[i];
    if (!word) continue;
    while (measure(word, size) > maxWidth) {
      // hard-break very long tokens (ids, paths)
      let cut = word.length - 1;
      while (cut > 1 && measure(word.slice(0, cut), size) > maxWidth) cut--;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, size) <= maxWidth) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fitText(`${kept[maxLines - 1]} ${lines[maxLines]}`, maxWidth, size);
    if (!kept[maxLines - 1].endsWith('..')) kept[maxLines - 1] = fitText(`${kept[maxLines - 1]}...`, maxWidth, size);
    return kept;
  }
  return lines;
}

/**
 * Pre-render text to its own small canvas (for labels drawn every frame).
 * opts: { shadow: color for a 1px drop shadow, outline: color for a 1px outline, scale }
 */
export function renderText(text, color, size = 'md', opts = {}) {
  const scale = opts.scale || 1;
  const pad = opts.outline ? scale : 0;
  const w = Math.max(1, measure(text, size, scale) + pad * 2 + (opts.shadow ? scale : 0));
  const h = FONTS[size].h * scale + pad * 2 + (opts.shadow ? scale : 0);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (opts.outline) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx || dy) drawText(g, text, pad + dx * scale, pad + dy * scale, opts.outline, size, scale);
      }
    }
  }
  if (opts.shadow) drawText(g, text, pad + scale, pad + scale, opts.shadow, size, scale);
  drawText(g, text, pad, pad, color, size, scale);
  return c;
}
