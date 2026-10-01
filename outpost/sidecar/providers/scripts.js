// Offline demo behaviour for every station agent (used by the scripted provider).
//
// The decisions here are scripted; everything they set in motion is real: tool calls go through
// capability checks, validation and approval gates, files are written and hashed, events are
// logged. Each script is a small state machine over the run's own message history (which tools
// it already called and what came back), so it reacts to real tool results, including denials
// and errors. Every artifact a script writes says it is scripted demo content.

import { ORIGINALITY_RULE } from '../recipes.js';

export const SCRIPTED_NOTICE = 'SCRIPTED DEMO — produced without a language model or live market data';

const ART_ID = /\bart_[a-z0-9]+\b/g;
const MAX_READS = 8;

// ---------------------------------------------------------------------------------------------
// Reading the run's history

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Every tool call made so far in this run, paired with its result once it arrived. */
function callHistory(messages) {
  const calls = [];
  const byId = new Map();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (m.role === 'assistant' && b.type === 'tool_use') {
        const call = { name: b.name, input: b.input, result: null };
        calls.push(call);
        byId.set(b.id, call);
      } else if (m.role === 'user' && b.type === 'tool_result' && byId.has(b.tool_use_id)) {
        const text = blockText(b.content);
        byId.get(b.tool_use_id).result = { text, isError: b.is_error === true, json: parseJson(text) };
      }
    }
  }
  return calls;
}

const unique = (xs) => [...new Set(xs)];
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function view({ task = {}, messages = [] }) {
  const calls = callHistory(messages);
  const firstMessage = blockText(messages[0]?.content);
  const brief = task.brief || '';
  const reads = calls.filter((c) => c.name === 'read_artifact' && c.result && !c.result.isError && c.result.json);
  return {
    task,
    brief,
    goal: (task.brief || task.title || '').trim(),
    calls,
    // Ids quoted inside artifact previews are references, not inputs, so the message is only a
    // fallback for a task object that arrives without its inputs.
    inputIds: task.inputs?.length ? unique(task.inputs) : unique(firstMessage.match(ART_ID) || []),
    inputs: reads.map((c) => c.result.json),
    /** Value of a `Label: "value"` line in the brief (recipes and delegations write these). */
    field: (label) => brief.match(new RegExp(`^${escapeRegExp(label)}:\\s*"(.*)"\\s*$`, 'm'))?.[1]?.trim() || null,
    last: (name) => calls.filter((c) => c.name === name).at(-1),
    all: (name) => calls.filter((c) => c.name === name),
  };
}

const artifactIdOf = (call) => call?.result?.json?.artifact_id || call?.result?.text.match(ART_ID)?.[0] || null;
const inputText = (v, kinds) => v.inputs.filter((a) => kinds.includes(a.kind)).map((a) => a.preview || '').join('\n');

// ---------------------------------------------------------------------------------------------
// Turn rendering

/**
 * Wrap a step function into a scripted-provider script. A step returns `{text, calls}` to use
 * tools, or `{text}` to end the run.
 */
function script(step) {
  return (args) => {
    const turn = args.turn ?? (args.messages || []).filter((m) => m.role === 'assistant').length + 1;
    const { text, calls = [] } = step(view(args));
    const content = [{ type: 'text', text }];
    calls.forEach(([name, input], i) => content.push({ type: 'tool_use', id: `toolu_scripted_${turn}_${i}`, name, input }));
    return { content, stop_reason: calls.length ? 'tool_use' : 'end_turn' };
  };
}

function readInputs(v) {
  if (!v.inputIds.length || v.calls.some((c) => c.name === 'read_artifact')) return null;
  const ids = v.inputIds.slice(0, MAX_READS);
  return { text: `Reading ${ids.length} input artifact${ids.length === 1 ? '' : 's'}.`, calls: ids.map((id) => ['read_artifact', { artifact_id: id }]) };
}

const failure = (what, call) => `${what}: ${call.result?.text || 'no result'}`;
const artifactsLine = (ids) => `Artifacts: ${ids.filter(Boolean).join(', ') || 'none'}.`;
const DEMO_FOOTER = `\n\n---\n${SCRIPTED_NOTICE}.\n`;

// ---------------------------------------------------------------------------------------------
// Text helpers

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function clipWords(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,–-]+$/, '');
}

const isBotanical = (s) => /botanic|garden|plant|flower|floral|herb|leaf|bloom/i.test(s || '');

function headlineFor(niche) {
  return isBotanical(niche) ? 'Grow Gently' : 'Made With Care';
}

const VALID_TAG = /^[\p{L}\p{N} '-]{1,20}$/u;
const BOTANICAL_TAGS = [
  'garden sweatshirt', 'plant lover gift', 'botanical shirt', 'gardening gift', 'floral crewneck', 'pastel sweatshirt',
  'gift for gardener', 'wildflower top', 'cottagecore top', 'nature lover gift', 'typography shirt', 'plant mom',
];
const GENERIC_TAGS = ['original design', 'typography gift', 'graphic sweatshirt', 'statement top', 'unique gift', 'hand lettered', 'cozy crewneck', 'everyday wear', 'gift for her', 'gift for him'];

function tagsFor(niche, headline) {
  const nicheWords = (niche || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  const base = isBotanical(niche) ? BOTANICAL_TAGS : [...nicheWords, ...GENERIC_TAGS];
  return unique([...base, headline.toLowerCase()].filter((t) => VALID_TAG.test(t))).slice(0, 13);
}

function productNoun(niche) {
  const n = (niche || '').toLowerCase();
  if (n.includes('sweatshirt') || n.includes('crewneck')) return 'Sweatshirt';
  if (n.includes('hoodie')) return 'Hoodie';
  if (/\b(t-?shirts?|tees?|shirts?)\b/.test(n)) return 'T-Shirt';
  if (n.includes('mug')) return 'Mug';
  if (n.includes('tote')) return 'Tote Bag';
  return 'Print';
}

const STOP_WORDS = new Set(['i', 'a', 'an', 'the', 'in', 'on', 'of', 'at', 'to', 'for', 'and', 'with', 'my', 'during', 'from', 'into', 'by', 'is', 'was', 'we', 'you', 'it', 'this', 'that', 'our', 'me', 'how', 'why', 'what', 'vs']);

/** Three bold 2-3 word hooks derived from the video title (no claims the title does not make). */
export function hookTexts(videoTitle) {
  const title = videoTitle || '';
  const span = title.match(/\b(\d+)\s+(days?|hours?|nights?|weeks?|months?|years?|minutes?)\b/i);
  const words = title.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean);
  const content = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()) && !/^\d+$/.test(w) && w.toLowerCase() !== span?.[2].toLowerCase());
  const options = [];
  if (/blizzard|snow|storm|frozen|winter/i.test(title)) options.push('SNOWED IN');
  if (span) options.push(`${span[1]} ${span[2]}`);
  if (content.length >= 2) options.push(`${content.at(-1)} ${content.at(-2)}`);
  if (content.length >= 2) options.push(content.slice(0, 2).join(' '));
  if (content.length === 1) options.push(content[0]);
  options.push('WATCH THIS', 'NO WAY', 'IT HAPPENED');
  return unique(options.map((o) => o.toUpperCase().split(/\s+/).slice(0, 3).join(' '))).slice(0, 3);
}

function parseTextOptions(text) {
  const line = text.match(/Text options:\s*(.+)/)?.[1];
  if (!line) return null;
  const opts = line.split('|').map((s) => s.replace(/["“”]/g, '').trim()).filter(Boolean);
  return opts.length ? opts.slice(0, 3) : null;
}

// ---------------------------------------------------------------------------------------------
// Seeded randomness for the hand-drawn wobble (deterministic per headline)

function seeded(seed) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------------------------
// PIXEL: pastel botanical typography design for apparel (4500 x 5400)

const INK = '#3F5E4A';
const PASTEL = { sage: '#A9C6A0', mint: '#CFE3C6', blush: '#F2B8C6', rose: '#E792A9', butter: '#F6D98B', lavender: '#C9B6E4', glow: '#F7E9D9' };

function leaf(rand, x, y, angle, length, width, fill) {
  const j = () => 0.88 + rand() * 0.24;
  const L = length;
  const W = width;
  const body = `M0 0 C${r1(L * 0.22 * j())} ${r1(-W * 0.95 * j())} ${r1(L * 0.7 * j())} ${r1(-W * 0.8 * j())} ${L} 0 C${r1(L * 0.74 * j())} ${r1(W * 0.78 * j())} ${r1(L * 0.26 * j())} ${r1(W * 0.92 * j())} 0 0Z`;
  const rib = `M${r1(L * 0.06)} 0 Q${r1(L * 0.5)} ${r1(-W * 0.14 * j())} ${r1(L * 0.9)} ${r1(W * 0.03)}`;
  return `<g transform="translate(${r1(x)} ${r1(y)}) rotate(${r1(angle)})"><path d="${body}" fill="${fill}"/><path d="${rib}" fill="none" stroke-width="9"/></g>`;
}

function flower(rand, x, y, size, petal, center) {
  const petals = [];
  const w = size * 0.42;
  for (let i = 0; i < 5; i += 1) {
    const a = i * 72 + (rand() - 0.5) * 14;
    const l = size * (0.92 + rand() * 0.16);
    petals.push(`<path transform="rotate(${r1(a)})" d="M0 0 C${r1(-w)} ${r1(-l * 0.35)} ${r1(-w * 0.78)} ${r1(-l)} 0 ${r1(-l)} C${r1(w * 0.78)} ${r1(-l)} ${r1(w)} ${r1(-l * 0.35)} 0 0Z" fill="${petal}"/>`);
  }
  const dots = Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2 + rand() * 0.4;
    return `<circle cx="${r1(Math.cos(a) * size * 0.17)}" cy="${r1(Math.sin(a) * size * 0.17)}" r="${r1(size * 0.035)}" fill="${INK}" stroke="none"/>`;
  }).join('');
  return `<g transform="translate(${r1(x)} ${r1(y)})">${petals.join('')}<circle r="${r1(size * 0.26)}" fill="${center}"/>${dots}</g>`;
}

function bud(x, y, angle, size, fill) {
  return `<g transform="translate(${r1(x)} ${r1(y)}) rotate(${r1(angle)})"><path d="M0 0 C${r1(-size * 0.5)} ${r1(-size * 0.4)} ${r1(-size * 0.3)} ${r1(-size)} 0 ${r1(-size * 1.1)} C${r1(size * 0.3)} ${r1(-size)} ${r1(size * 0.5)} ${r1(-size * 0.4)} 0 0Z" fill="${fill}"/><path d="M${r1(-size * 0.35)} ${r1(-size * 0.1)} Q0 ${r1(-size * 0.45)} ${r1(size * 0.35)} ${r1(-size * 0.1)}" fill="${PASTEL.sage}"/></g>`;
}

function sparkle(x, y, s) {
  const k = s * 0.22;
  return `<path transform="translate(${r1(x)} ${r1(y)})" d="M0 ${-s} L${r1(k)} ${r1(-k)} L${s} 0 L${r1(k)} ${r1(k)} L0 ${s} L${r1(-k)} ${r1(k)} L${-s} 0 L${r1(-k)} ${r1(-k)}Z" fill="${PASTEL.butter}" stroke-width="7"/>`;
}

/** Leaves alternating along a cubic stem, sampled at t in (0.15, 0.9). */
function leavesAlong(rand, [p0, p1, p2, p3], count, length, width, side = 0) {
  const at = (t, a, b, c, d) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const t = 0.15 + (0.75 * i) / Math.max(1, count - 1);
    const x = at(t, p0[0], p1[0], p2[0], p3[0]);
    const y = at(t, p0[1], p1[1], p2[1], p3[1]);
    const dx = at(t + 0.01, p0[0], p1[0], p2[0], p3[0]) - x;
    const dy = at(t + 0.01, p0[1], p1[1], p2[1], p3[1]) - y;
    const heading = (Math.atan2(dy, dx) * 180) / Math.PI;
    const dir = side || (i % 2 === 0 ? -1 : 1);
    const scale = 1 - 0.35 * t;
    out.push(leaf(rand, x, y, heading + dir * (48 + rand() * 14), length * scale, width * scale, i % 3 === 0 ? PASTEL.mint : PASTEL.sage));
  }
  return out.join('');
}

const stemPath = ([p0, p1, p2, p3]) => `M${p0.join(' ')} C${p1.join(' ')} ${p2.join(' ')} ${p3.join(' ')}`;

/** An original pastel botanical typography design: arched headline over a hand-drawn emblem. */
export function botanicalDesign(headline) {
  const rand = seeded(headline);
  const text = headline.toUpperCase();
  const words = text.split(/\s+/);
  const twoLines = text.length > 16 && words.length > 1;
  const arcText = twoLines ? words.slice(0, Math.ceil(words.length / 2)).join(' ') : text;
  const lowerText = twoLines ? words.slice(Math.ceil(words.length / 2)).join(' ') : '';

  const cx = 2250;
  const glowY = 3300; // centre of the emblem's backdrop disc
  const radius = 2800; // a wide, gentle arch keeps the letters close to upright
  const arcY = 1450 + radius; // the arch peaks at y=1450
  const half = (50 * Math.PI) / 180;
  const sx = r1(cx - radius * Math.sin(half));
  const sy = r1(arcY - radius * Math.cos(half));
  const ex = r1(cx + radius * Math.sin(half));
  const fontSize = Math.round(Math.min(560, 3400 / (arcText.length * 0.78)));
  const lowerSize = Math.round(Math.min(420, 3600 / Math.max(1, lowerText.length * 0.7)));

  const main = [[2250, 4150], [2200, 3700], [2300, 3050], [2250, 2420]];
  const left = [[2250, 4050], [1960, 3800], [1720, 3380], [1640, 2860]];
  const right = [[2250, 4050], [2560, 3820], [2790, 3400], [2860, 2900]];
  const sprigL = [[1980, 3950], [1650, 3880], [1420, 3620], [1330, 3330]];
  const sprigR = [[2520, 3950], [2860, 3880], [3080, 3620], [3170, 3330]];

  const sparkles = [[1180, 2560, 70], [3330, 2480, 85], [1500, 4280, 55], [3010, 4300, 60], [2250, 1880, 50]]
    .map(([x, y, s]) => sparkle(x + (rand() - 0.5) * 60, y + (rand() - 0.5) * 60, s)).join('');
  const seeds = Array.from({ length: 16 }, () => {
    const a = rand() * Math.PI * 2;
    const d = 1090 + rand() * 120;
    return `<circle cx="${r1(cx + Math.cos(a) * d)}" cy="${r1(glowY + Math.sin(a) * d)}" r="${r1(14 + rand() * 12)}" fill="${INK}" opacity="0.55"/>`;
  }).join('');

  const textAttrs = `font-family="Georgia, 'DejaVu Serif', 'Times New Roman', serif" font-weight="700" text-anchor="middle"`;
  const lower = twoLines
    ? `<text x="2250" y="4720" ${textAttrs} font-size="${lowerSize}" letter-spacing="${Math.round(lowerSize * 0.08)}" fill="${PASTEL.blush}" transform="translate(12 12)">${xml(lowerText)}</text>` +
      `<text x="2250" y="4720" ${textAttrs} font-size="${lowerSize}" letter-spacing="${Math.round(lowerSize * 0.08)}" fill="${INK}">${xml(lowerText)}</text>`
    : `<g stroke="${INK}" stroke-width="12" stroke-linecap="round" fill="none"><path d="M1500 4560 H2080"/><path d="M2420 4560 H3000"/></g>` +
      leaf(rand, 2160, 4560, -150, 150, 60, PASTEL.sage) + leaf(rand, 2340, 4560, -30, 150, 60, PASTEL.sage) +
      `<circle cx="2250" cy="4560" r="34" fill="${PASTEL.blush}" stroke="${INK}" stroke-width="10"/>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 4500 5400" width="4500" height="5400">`,
    `<title>${xml(headline)}</title>`,
    `<desc>${SCRIPTED_NOTICE}. Original typography design: arched headline over a hand-drawn pastel botanical emblem. Transparent background for apparel printing.</desc>`,
    `<defs><path id="headline-arc" d="M${sx} ${sy} A${radius} ${radius} 0 0 1 ${ex} ${sy}" fill="none"/></defs>`,
    `<circle cx="${cx}" cy="${glowY}" r="1020" fill="${PASTEL.glow}"/>`,
    `<circle cx="${cx}" cy="${glowY}" r="1020" fill="none" stroke="${PASTEL.blush}" stroke-width="18" stroke-dasharray="4 46" stroke-linecap="round"/>`,
    seeds,
    `<g stroke="${INK}" stroke-width="12" stroke-linejoin="round" stroke-linecap="round">`,
    `<path d="${stemPath(main)}" fill="none" stroke-width="16"/>`,
    `<path d="${stemPath(left)}" fill="none"/><path d="${stemPath(right)}" fill="none"/>`,
    `<path d="${stemPath(sprigL)}" fill="none"/><path d="${stemPath(sprigR)}" fill="none"/>`,
    '<path d="M2262 3200 Q2120 3080 2010 2870" fill="none"/><path d="M2258 3150 Q2400 3030 2500 2840" fill="none"/>',
    leavesAlong(rand, main, 6, 330, 120),
    leavesAlong(rand, left, 4, 300, 115),
    leavesAlong(rand, right, 4, 300, 115),
    leavesAlong(rand, sprigL, 5, 200, 90, -1),
    leavesAlong(rand, sprigR, 5, 200, 90, 1),
    flower(rand, 2250, 2400, 330, PASTEL.blush, PASTEL.butter),
    flower(rand, 1640, 2850, 230, PASTEL.butter, PASTEL.rose),
    flower(rand, 2860, 2890, 240, PASTEL.lavender, PASTEL.butter),
    bud(1330, 3330, -35, 120, PASTEL.rose),
    bud(3170, 3330, 35, 120, PASTEL.lavender),
    bud(2010, 2870, -20, 95, PASTEL.blush),
    bud(2500, 2840, 22, 95, PASTEL.butter),
    sparkles,
    '</g>',
    `<text ${textAttrs} font-size="${fontSize}" letter-spacing="${Math.round(fontSize * 0.06)}" fill="${PASTEL.blush}" transform="translate(14 14)"><textPath href="#headline-arc" xlink:href="#headline-arc" startOffset="50%">${xml(arcText)}</textPath></text>`,
    `<text ${textAttrs} font-size="${fontSize}" letter-spacing="${Math.round(fontSize * 0.06)}" fill="${INK}"><textPath href="#headline-arc" xlink:href="#headline-arc" startOffset="50%">${xml(arcText)}</textPath></text>`,
    lower,
    '</svg>',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// FLUX: three 1280x720 thumbnail variants and an honest, computed scorecard

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours (1..21). */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THUMB_FONT = `font-family="Impact, Anton, 'Arial Black', 'Helvetica Neue', sans-serif" font-weight="900"`;

function snow(rand, count, box, color = '#FFFFFF') {
  return Array.from({ length: count }, () => {
    const x = box[0] + rand() * box[2];
    const y = box[1] + rand() * box[3];
    return `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(2 + rand() * 5)}" fill="${color}" opacity="${r1(0.5 + rand() * 0.5)}"/>`;
  }).join('');
}

function cabin(x, y, s) {
  return `<g transform="translate(${x} ${y}) scale(${s})">` +
    '<path d="M-150 0 V-120 H150 V0Z" fill="#3A2416"/>' +
    '<path d="M-185 -110 L0 -250 L185 -110Z" fill="#1B120B"/>' +
    '<path d="M-200 -105 L0 -262 L200 -105 L178 -96 L0 -232 L-178 -96Z" fill="#FFFFFF"/>' +
    '<rect x="80" y="-240" width="40" height="80" fill="#1B120B"/>' +
    '<rect x="-95" y="-90" width="70" height="60" fill="#FFC94A"/><rect x="25" y="-90" width="70" height="60" fill="#FFC94A"/>' +
    '<path d="M-60 -90 V-30 M60 -90 V-30" stroke="#3A2416" stroke-width="8"/>' +
    '</g>';
}

function fitSize(lines, width, max) {
  const longest = Math.max(...lines.map((l) => l.length));
  return Math.floor(Math.min(max, width / (longest * 0.64)));
}

/** The three variant specs for a set of hooks; the score is computed from these numbers. */
export function thumbnailVariants(hooks, seed) {
  const [a, b, c] = [hooks[0], hooks[1] ?? hooks[0], hooks[2] ?? hooks[0]];
  const rand = seeded(seed);

  const aLines = a.split(' ');
  const aSize = fitSize(aLines, 540, 210);
  const aText = aLines.map((w, i) => `<text x="60" y="${170 + i * aSize * 0.98 + (3 - aLines.length) * 90}" ${THUMB_FONT} font-size="${aSize}" fill="#FFFFFF" stroke="#000000" stroke-width="8" paint-order="stroke">${xml(w)}</text>`).join('');
  const variantA = {
    label: 'A',
    composition: 'split panel',
    text: a,
    fontSize: aSize,
    textColor: '#FFFFFF',
    background: '#0B1E3F',
    svg: [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">',
      `<desc>${SCRIPTED_NOTICE}. Variant A, split panel.</desc>`,
      '<defs><linearGradient id="ice" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#CFEFFF"/><stop offset="1" stop-color="#4C9BE0"/></linearGradient></defs>',
      '<rect width="1280" height="720" fill="url(#ice)"/>',
      snow(rand, 70, [640, 0, 640, 720]),
      '<path d="M600 720 Q900 560 1280 640 V720Z" fill="#FFFFFF"/>',
      cabin(960, 600, 1.15),
      '<path d="M0 0 H640 L590 720 H0Z" fill="#0B1E3F"/>',
      aText,
      '<path d="M600 520 L700 520 L700 490 L760 545 L700 600 L700 570 L600 570Z" fill="#FFD400" stroke="#000000" stroke-width="6"/>',
      '</svg>',
    ].join(''),
  };

  const bLines = b.split(' ').length > 2 ? [b.split(' ').slice(0, 2).join(' '), b.split(' ').slice(2).join(' ')] : [b];
  const bSize = fitSize(bLines, 1100, 250);
  const bText = bLines.map((line, i) => {
    const y = 360 + (i - (bLines.length - 1) / 2) * bSize * 1.02 + bSize * 0.35;
    const spans = line.split(' ').map((w) => (/\d/.test(w) ? `<tspan fill="#FFD400">${xml(w)}</tspan>` : xml(w))).join(' ');
    return `<text x="640" y="${r1(y)}" text-anchor="middle" ${THUMB_FONT} font-size="${bSize}" fill="#FFFFFF" stroke="#000000" stroke-width="12" paint-order="stroke">${spans}</text>`;
  }).join('');
  const variantB = {
    label: 'B',
    composition: 'centre punch',
    text: b,
    fontSize: bSize,
    textColor: '#FFFFFF',
    background: '#120726',
    svg: [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">',
      `<desc>${SCRIPTED_NOTICE}. Variant B, centre punch.</desc>`,
      '<defs><radialGradient id="glow" cx="0.5" cy="0.5" r="0.7"><stop offset="0" stop-color="#3D2A7A"/><stop offset="0.6" stop-color="#120726"/><stop offset="1" stop-color="#05020C"/></radialGradient></defs>',
      '<rect width="1280" height="720" fill="url(#glow)"/>',
      snow(rand, 120, [0, 0, 1280, 720], '#DDEBFF'),
      cabin(1120, 690, 0.55),
      '<rect x="0" y="650" width="1280" height="70" fill="#FFFFFF" opacity="0.9"/>',
      bText,
      '<rect x="40" y="40" width="1200" height="640" fill="none" stroke="#FFD400" stroke-width="10"/>',
      '</svg>',
    ].join(''),
  };

  const cLines = c.split(' ');
  const cSize = fitSize([c], 1080, 170);
  const variantC = {
    label: 'C',
    composition: 'diagonal clash',
    text: c,
    fontSize: cSize,
    textColor: '#111111',
    background: '#FFFFFF',
    svg: [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">',
      `<desc>${SCRIPTED_NOTICE}. Variant C, diagonal clash.</desc>`,
      '<path d="M0 0 H1280 V260 L0 520Z" fill="#FF6B1A"/>',
      '<path d="M0 520 L1280 260 V720 H0Z" fill="#123A6B"/>',
      snow(rand, 60, [0, 380, 1280, 340]),
      '<g transform="rotate(-11 640 390)"><rect x="-40" y="300" width="1360" height="190" fill="#FFFFFF" stroke="#000000" stroke-width="8"/>',
      `<text x="640" y="${r1(395 + cSize * 0.36)}" text-anchor="middle" ${THUMB_FONT} font-size="${cSize}" fill="#111111">${xml(cLines.join(' '))}</text></g>`,
      '<g transform="translate(130 30) scale(0.8)"><rect x="-26" y="0" width="52" height="300" rx="26" fill="#FFFFFF" stroke="#000000" stroke-width="8"/>',
      '<rect x="-12" y="220" width="24" height="90" fill="#E3262E"/><circle cx="0" cy="330" r="52" fill="#E3262E" stroke="#000000" stroke-width="8"/></g>',
      '</svg>',
    ].join(''),
  };
  return [variantA, variantB, variantC];
}

/** Legibility heuristic computed from the design itself; not a click-through prediction. */
export function scoreVariant(v) {
  const contrast = contrastRatio(v.textColor, v.background);
  const capHeightPx = v.fontSize * 0.72 * (168 / 1280); // as shown in a 168 px wide thumbnail slot
  const words = v.text.split(/\s+/).length;
  const score = Math.round(40 * Math.min(contrast / 15, 1) + 40 * Math.min(capHeightPx / 20, 1) + (words <= 3 ? 20 : 10));
  return { contrast: Math.round(contrast * 10) / 10, capHeightPx: Math.round(capHeightPx * 10) / 10, words, score };
}

// ---------------------------------------------------------------------------------------------
// Documents the research agents write (scripted placeholders, labelled as such)

function podResearch(niche, audience) {
  const headline = headlineFor(niche);
  const tags = tagsFor(niche, headline);
  return {
    label: 'the niche research brief',
    path: `research/${slug(niche)}.md`,
    content: `# Research brief: ${niche}

> ${SCRIPTED_NOTICE}. No marketplace or web data was read; this is a structured placeholder showing the shape of a real brief.

Audience: ${audience || 'not specified'}

## Themes to explore (patterns, not copies)
- Hand-lettered garden words paired with simple line-drawn leaves and wildflowers
- Soft, earthy pastels (sage, blush, butter yellow, lavender) on light garments
- Gentle humour about patience, growth and slow mornings outdoors
- Arched headline layouts over a small botanical emblem

## Working headline
Working headline: "${headline}"

## Candidate tags
Candidate tags: ${tags.join(', ')}

## Price
Demo price assumption: $34.00 (a placeholder for the pipeline, not a market observation; a live run cites observed price bands).

## What a live run would establish
- Observed price bands for comparable items, with sources
- Which motifs recur across many listings, and where the gaps are
- Search terms buyers use, to refine the tags above

${ORIGINALITY_RULE}
${DEMO_FOOTER}`,
  };
}

function demandResearch(market) {
  return {
    label: 'the demand brief',
    path: `research/demand-${slug(market)}.md`,
    content: `# Demand brief: ${market}

> ${SCRIPTED_NOTICE}. No marketplace or web data was read. Every point below is a question a live run answers with sources, not a finding.

## Questions a live scan answers
- What do buyers ask for most often (formats, turnaround, revisions)?
- Which price bands do completed orders cluster in?
- Which requests go unanswered or get poor reviews (gaps)?
- What volume of demand is visible, and how seasonal is it?

## Signals to collect
- Search suggestions and category filters on the marketplace
- Public buyer requests and FAQ patterns across many sellers

${ORIGINALITY_RULE}
${DEMO_FOOTER}`,
  };
}

function competitorResearch(market) {
  return {
    label: 'the competitor brief',
    path: `research/competitors-${slug(market)}.md`,
    content: `# Competitor brief: ${market}

> ${SCRIPTED_NOTICE}. No seller pages were read. This is the frame a live run fills in with observed patterns and sources.

## Patterns to map across many sellers
- Offer tiers (basic / standard / premium) and what each includes
- Price per tier, turnaround and revision counts
- Quality bar: text legibility at small sizes, contrast, face and subject clarity
- Positioning angles (speed, niche specialism, data-backed design)

## Gaps worth testing
- Fast turnaround with a measurable legibility check included
- Clear revision policy and delivery formats

${ORIGINALITY_RULE}
${DEMO_FOOTER}`,
  };
}

function orderIntake(orderRef, videoTitle, style) {
  const hooks = hookTexts(videoTitle);
  return {
    label: `the intake spec for order ${orderRef}`,
    path: `intake/${slug(orderRef)}.md`,
    content: `# Intake spec: order ${orderRef}

> ${SCRIPTED_NOTICE}. Parsed from the order details only.

Video title: "${videoTitle}"
Requested style: ${style || 'not specified'}

## On-image text
Text options: ${hooks.map((h) => `"${h}"`).join(' | ')}
Rule: 2-3 words, readable when the thumbnail is shown about 168 px wide.

## Composition
- One focal subject drawn from the title, large and uncluttered
- High contrast between text and its background; thick outline on light-on-dark text
- Three distinct layouts: split panel, centre punch, diagonal clash

## Deliverable
1280x720, delivered as files the operator hands over (no platform API).

${ORIGINALITY_RULE}
${DEMO_FOOTER}`,
  };
}

function goalPlan(goal, agentName) {
  return {
    label: 'the research plan',
    path: `research/plan-${slug(goal)}.md`,
    content: `# Research plan

> ${SCRIPTED_NOTICE}. ${agentName} did not search the web; this plan lists what a live run would investigate.

Operator goal: ${goal}

## Questions
- Who buys this, and what do they ask for?
- Which price bands and formats recur across many sellers?
- Where are the gaps the station's rooms can fill (Production Bay or Output Studio)?

## Next step
Run with a model connected (ANTHROPIC_API_KEY) to research with sources.

${ORIGINALITY_RULE}
${DEMO_FOOTER}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Shared flows

/** Write one document, file a pointer in room memory, then finish. */
function researchFlow(v, doc, memoryKey) {
  const wrote = v.last('write_file');
  if (!wrote) return { text: `Writing ${doc.label}.`, calls: [['write_file', { path: doc.path, content: doc.content }]] };
  if (wrote.result?.isError) return { text: `${failure('I could not save the document', wrote)}. Nothing was produced.` };
  const id = artifactIdOf(wrote);
  if (!v.last('memory_write')) {
    return {
      text: 'Filing a pointer in the room archive for future runs.',
      calls: [['memory_write', { key: memoryKey, content: `Latest: ${doc.label}, artifact ${id} (${doc.path}). ${SCRIPTED_NOTICE}.` }]],
    };
  }
  return { text: `Saved ${doc.label} as ${id}. ${SCRIPTED_NOTICE}: it is a labelled placeholder, not research findings. ${artifactsLine([id])}` };
}

function deniedOrFailed(action, call) {
  const reason = call.result?.text || 'no result';
  if (/^operator denied/i.test(reason)) return `The operator denied ${action} (${reason.replace(/^operator denied:\s*/i, '')}). I will not retry or work around it; nothing was sent.`;
  return `${action[0].toUpperCase()}${action.slice(1)} did not happen: ${reason}. Nothing was sent.`;
}

// ---------------------------------------------------------------------------------------------
// Agents

const nova = script((v) => {
  const read = readInputs(v);
  if (read) return read;
  const niche = v.field('Niche');
  const market = v.field('Market');
  const doc = niche ? podResearch(niche, v.field('Audience')) : market ? demandResearch(market) : goalPlan(v.goal, 'NOVA');
  return researchFlow(v, doc, 'latest-brief');
});

const vega = script((v) => {
  const read = readInputs(v);
  if (read) return read;
  const orderRef = v.field('Order ref');
  const market = v.field('Market');
  const doc = orderRef ? orderIntake(orderRef, v.field('Video title') || v.goal, v.field('Style'))
    : market ? competitorResearch(market) : goalPlan(v.goal, 'VEGA');
  return researchFlow(v, doc, orderRef ? 'latest-intake' : 'latest-competitor-brief');
});

const pixel = script((v) => {
  const read = readInputs(v);
  if (read) return read;
  const rendered = v.last('render_svg_design');
  const niche = v.field('Niche');
  const headline = inputText(v, ['text', 'json']).match(/Working headline:\s*"([^"\n]{1,40})"/)?.[1]?.trim()
    || v.field('Headline') || headlineFor(niche || v.goal);
  if (!rendered) {
    return {
      text: `Drawing an original typography design around "${headline}": arched serif headline over a hand-drawn pastel botanical emblem.`,
      calls: [['render_svg_design', {
        title: `"${headline}" botanical typography design`,
        svg: botanicalDesign(headline),
        notes: `${SCRIPTED_NOTICE}. Palette: deep sage ink #3F5E4A with sage, mint, blush, butter and lavender pastels; transparent background. Best on cream, oatmeal, light pink or sage garments. Before sending to a print provider, convert the text to outlines (the file names Georgia with serif fallbacks) and export at 4500x5400.`,
      }]],
    };
  }
  if (rendered.result?.isError) return { text: `${failure('The design was refused', rendered)}. No artifact was produced.` };
  const id = artifactIdOf(rendered);
  return { text: `Design "${headline}" saved as ${id} (4500x5400 SVG, transparent background). ${SCRIPTED_NOTICE}. ${artifactsLine([id])}` };
});

function listingInput(v, designIds) {
  const research = inputText(v, ['text']);
  const niche = v.field('Niche') || 'original typography designs';
  const audience = v.field('Audience');
  const headline = research.match(/Working headline:\s*"([^"\n]{1,40})"/)?.[1]
    || v.inputs.find((a) => a.kind === 'svg')?.title?.match(/"([^"]+)"/)?.[1] || headlineFor(niche);
  const tagLine = research.match(/Candidate tags:\s*(.+)/)?.[1];
  const tags = unique((tagLine ? tagLine.split(',') : tagsFor(niche, headline)).map((t) => t.trim().toLowerCase()).filter((t) => VALID_TAG.test(t))).slice(0, 13);
  const price = Number(research.match(/Demo price assumption:\s*\$(\d+(?:\.\d{1,2})?)/)?.[1] ?? 34);
  const noun = productNoun(niche);
  const gift = /garden/i.test(audience || niche) ? 'Gift for Gardeners' : 'Thoughtful Gift';
  return {
    title: clipWords(`${headline} ${noun} – Original Pastel Botanical Typography, Hand-Drawn Wildflowers, ${gift}`, 140),
    description: [
      `"${headline}": an original hand-lettered typography design with pastel leaves and wildflowers${audience ? `, made for ${audience}` : ''}.`,
      '',
      `• Artwork: arched serif headline over a hand-drawn botanical emblem (design file ${designIds[0]})`,
      '• Made to order after purchase. [Operator: confirm your print partner, garment brand and sizing before activating.]',
      '• Colours on screen are a digital preview and may vary slightly in print.',
      '',
      `${SCRIPTED_NOTICE}.`,
    ].join('\n'),
    tags,
    price_usd: price,
    quantity: 25,
    when_made: 'made_to_order',
    artifact_ids: designIds,
    ai_disclosure: 'Drafted in OUTPOST, an AI-agent workspace. This draft came from its scripted demo mode (no language model was used); the shop owner reviews every listing before it goes live.',
    originality_note: 'Original design: headline, lettering layout and botanical artwork were created for this listing from generic themes (hand-lettered garden words, pastel leaves). No specific existing listing, artwork, wording, character, logo or trademark was referenced or copied.',
  };
}

const quill = script((v) => {
  const read = readInputs(v);
  if (read) return read;

  const draft = v.inputs.find((a) => a.kind === 'listing_draft');
  if (draft) {
    const published = v.last('publish_listing');
    if (!published) {
      return { text: `Sending listing draft ${draft.artifact_id} to the publish gate; this waits for operator approval.`, calls: [['publish_listing', { draft_artifact_id: draft.artifact_id }]] };
    }
    if (published.result?.isError) return { text: deniedOrFailed('publication', published) };
    const receipt = published.result.text.match(ART_ID)?.at(-1);
    return { text: `${published.result.text} ${artifactsLine([receipt])}` };
  }

  const designs = v.inputs.filter((a) => a.kind === 'svg' || a.kind === 'image').map((a) => a.artifact_id);
  if (!designs.length) return { text: 'None of my inputs is a design (svg or image artifact), so there is nothing to list. No draft was written.' };
  const drafted = v.last('create_listing_draft');
  if (!drafted) return { text: 'Writing the Etsy listing draft within marketplace limits.', calls: [['create_listing_draft', listingInput(v, designs)]] };
  if (drafted.result?.isError) return { text: `${failure('The listing draft was rejected', drafted)}. No draft was saved.` };
  const id = artifactIdOf(drafted);
  return { text: `Listing draft ${id} saved (draft only; publishing needs the gate and operator approval). ${SCRIPTED_NOTICE}. ${artifactsLine([id])}` };
});

function designFlow(v) {
  const orderRef = v.field('Order ref') || 'UNSPECIFIED';
  const videoTitle = v.field('Video title') || v.goal;
  const hooks = parseTextOptions(inputText(v, ['text'])) || hookTexts(videoTitle);
  const variants = thumbnailVariants(hooks, `${orderRef}:${videoTitle}`);
  const renders = v.all('render_svg_design');
  if (!renders.length) {
    return {
      text: `Drafting three 1280x720 variants for order ${orderRef}: ${variants.map((x) => `${x.label} ${x.composition} "${x.text}"`).join('; ')}.`,
      calls: variants.map((x) => ['render_svg_design', {
        title: `Order ${orderRef} variant ${x.label}: ${x.composition}, "${x.text}"`,
        svg: x.svg,
        notes: `${SCRIPTED_NOTICE}. ${x.composition} layout; headline "${x.text}" in ${x.textColor} on ${x.background}.`,
      }]),
    };
  }

  const made = variants.map((x, i) => ({ ...x, ...scoreVariant(x), id: renders[i]?.result?.isError ? null : artifactIdOf(renders[i]) })).filter((x) => x.id);
  if (!made.length) return { text: `${failure('Every variant was refused', renders[0])}. Nothing to package.` };
  const winner = [...made].sort((a, b) => b.score - a.score)[0];

  const card = v.last('write_file');
  if (!card) {
    const rows = made.map((x) => `| ${x.label} | ${x.id} | ${x.composition} | "${x.text}" | ${x.contrast}:1 | ${x.capHeightPx} px | ${x.words} | ${x.score} |`).join('\n');
    return {
      text: `Scoring the variants: winner is ${winner.label} (${winner.score}/100).`,
      calls: [['write_file', {
        path: `orders/${slug(orderRef)}/scorecard.md`,
        content: `# Scorecard: order ${orderRef}

> ${SCRIPTED_NOTICE}.

Video title: "${videoTitle}"

Scores are computed from the designs themselves: WCAG contrast between the headline and its background (40 points, full at 15:1), headline cap height when the thumbnail is shown 168 px wide (40 points, full at 20 px), and 3 words or fewer (20 points). This is a legibility heuristic, not a click-through prediction.

| Variant | Artifact | Composition | Text | Contrast | Cap height @168px | Words | Score |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

Winner: variant ${winner.label} (${winner.id}).
${DEMO_FOOTER}`,
      }]],
    };
  }

  const packaged = v.last('package_deliverable');
  const cardId = card.result?.isError ? null : artifactIdOf(card);
  if (!packaged) {
    return {
      text: `Packaging the winning variant ${winner.label}${cardId ? ' with the scorecard' : ''}.`,
      calls: [['package_deliverable', {
        title: `Order ${orderRef}: thumbnail delivery`,
        artifact_ids: [winner.id, cardId].filter(Boolean),
        notes: `Order ref: ${orderRef}\nVideo title: "${videoTitle}"\nWinner: variant ${winner.label} ("${winner.text}", ${winner.score}/100 legibility heuristic).\n${SCRIPTED_NOTICE}.`,
      }]],
    };
  }
  if (packaged.result?.isError) return { text: `${failure('Packaging failed', packaged)}. Variants: ${made.map((x) => x.id).join(', ')}.` };
  const pkg = artifactIdOf(packaged);
  return { text: `Order ${orderRef}: three variants drafted, scored, and the winner (${winner.label}) packaged as ${pkg}. ${SCRIPTED_NOTICE}. ${artifactsLine([...made.map((x) => x.id), cardId, pkg])}` };
}

function deliverFlow(v, pkg) {
  const notes = parseJson(pkg.preview)?.notes ?? pkg.preview ?? '';
  const orderRef = v.field('Order ref') || notes.match(/Order ref:\s*"?([A-Za-z0-9._-]+)/)?.[1];
  if (!orderRef) return { text: `Package ${pkg.artifact_id} has no order ref in its notes or my brief, so I cannot prepare a delivery.` };
  const videoTitle = notes.match(/Video title:\s*"(.+?)"/)?.[1] || 'your video';
  const delivered = v.last('deliver_order');
  if (!delivered) {
    return {
      text: `Preparing the hand-off for order ${orderRef}; this waits for operator approval.`,
      calls: [['deliver_order', {
        package_artifact_id: pkg.artifact_id,
        order_ref: orderRef,
        message: `Hi! Your thumbnail for "${videoTitle}" is attached (1280x720), with a short scorecard explaining the choice. If you would like a revision, tell me what to change and I will turn it around.\n\n(${SCRIPTED_NOTICE}.)`,
      }]],
    };
  }
  if (delivered.result?.isError) return { text: deniedOrFailed('the delivery', delivered) };
  const id = delivered.result.text.match(ART_ID)?.[0];
  return { text: `${delivered.result.text} ${artifactsLine([id])}` };
}

const flux = script((v) => {
  const read = readInputs(v);
  if (read) return read;
  const pkg = v.inputs.find((a) => a.kind === 'package');
  return pkg ? deliverFlow(v, pkg) : designFlow(v);
});

function listingProblems(preview) {
  const draft = parseJson(preview);
  if (!draft) return ['the draft preview could not be parsed'];
  const problems = [];
  if (!draft.title || draft.title.length > 140) problems.push('title missing or over 140 characters');
  if (!Array.isArray(draft.tags) || draft.tags.length < 1 || draft.tags.length > 13 || draft.tags.some((t) => t.length > 20)) problems.push('tags outside Etsy limits');
  if (!draft.ai_disclosure?.trim()) problems.push('no AI disclosure');
  if (!draft.originality_note?.trim()) problems.push('no originality note');
  if (!draft.artifact_ids?.length) problems.push('no design attached');
  return problems;
}

function reviewFlow(v) {
  const delegated = v.last('delegate_task');
  if (delegated) {
    if (delegated.result?.isError) return { text: `Review done, but the follow-up could not be assigned: ${delegated.result.text}` };
    return { text: `Review complete. ${delegated.input.title} is now task ${delegated.result.json?.task_id ?? '(id unavailable)'} for ${delegated.input.agent_id.toUpperCase()}; I will review what comes back.` };
  }

  // Outcomes first: a receipt or hand-off closes the loop, so its draft or package is never resubmitted.
  const receipt = v.inputs.find((a) => a.kind === 'publish_receipt');
  if (receipt) {
    const mode = parseJson(receipt.preview)?.mode;
    const what = mode === 'dry_run' ? 'as a DRY RUN: nothing was sent to any marketplace' : mode === 'etsy_draft' ? 'as an Etsy DRAFT listing (not active until the operator activates it)' : `in mode ${mode ?? 'unknown'}`;
    return { text: `Publication finished ${what}. Receipt: ${receipt.artifact_id}. ${SCRIPTED_NOTICE}.` };
  }
  const delivery = v.inputs.find((a) => a.kind === 'delivery');
  if (delivery) return { text: `Delivery hand-off ${delivery.artifact_id} is ready: manual delivery required (Fiverr has no seller API). The operator attaches the files and pastes the message. ${SCRIPTED_NOTICE}.` };

  const draft = v.inputs.find((a) => a.kind === 'listing_draft');
  if (draft) {
    const problems = listingProblems(draft.preview);
    const fix = problems.length > 0;
    return {
      text: fix ? `The draft needs fixes: ${problems.join('; ')}.` : `Draft ${draft.artifact_id} passes review (limits, disclosure, originality note, design attached). Requesting publication through the Production Bay gate.`,
      calls: [['delegate_task', {
        agent_id: draft.agent,
        title: fix ? `Revise listing draft ${draft.artifact_id}` : `Publish listing draft ${draft.artifact_id}`,
        brief: fix
          ? `Revise listing draft ${draft.artifact_id}: ${problems.join('; ')}. Produce: a corrected listing_draft artifact.\n\n${ORIGINALITY_RULE}`
          : `Approved by ORION after review. Publish listing draft ${draft.artifact_id} through the publish gate. The operator must approve; with no Etsy connector this is a dry run that sends nothing. Produce: a publish_receipt artifact.`,
        artifact_ids: [draft.artifact_id],
      }]],
    };
  }

  const pkg = v.inputs.find((a) => a.kind === 'package');
  if (pkg) {
    const manifest = parseJson(pkg.preview);
    const orderRef = v.field('Order ref') || (manifest?.notes ?? pkg.preview).match(/Order ref:\s*"?([A-Za-z0-9._-]+)/)?.[1];
    const ok = manifest?.files?.length > 0 && manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)) && orderRef;
    if (!ok) return { text: `Package ${pkg.artifact_id} cannot go to delivery: ${orderRef ? 'its manifest is missing verified files' : 'no order ref found'}. No delivery requested.` };
    return {
      text: `Package ${pkg.artifact_id} passes review (${manifest.files.length} verified file(s) for order ${orderRef}). Requesting a manual delivery through the Output Studio gate.`,
      calls: [['delegate_task', {
        agent_id: pkg.agent,
        title: `Deliver order ${orderRef}`,
        brief: `Order ref: "${orderRef}"\n\nApproved by ORION after review. Prepare the delivery of package ${pkg.artifact_id}. The operator must approve, and delivery is a manual hand-off because Fiverr has no seller API. Produce: a delivery hand-off artifact.`,
        artifact_ids: [pkg.artifact_id],
      }]],
    };
  }

  if (!v.inputs.length) return { text: 'Nothing to review: no artifacts came back. See the child task results in my brief for what happened.' };
  const lines = v.inputs.map((a) => `- ${a.artifact_id} (${a.kind}, by ${a.agent}): ${a.title}`);
  return {
    text: `Synthesis of ${v.inputs.length} input(s):\n${lines.join('\n')}\n\nThese are scripted placeholders, so there are no verified findings to rank yet: connect a model (ANTHROPIC_API_KEY) and rerun to research with sources, then I can name the top opportunities and which room should act. ${SCRIPTED_NOTICE}.`,
  };
}

function goalFlow(v) {
  if (!v.last('list_tasks')) return { text: 'Checking the task board before assigning work.', calls: [['list_tasks', { status: null }]] };
  const delegated = v.last('delegate_task');
  if (!delegated) {
    const board = v.last('list_tasks').result?.json?.tasks || [];
    const active = board.filter((t) => ['queued', 'running', 'awaiting_approval'].includes(t.status)).length;
    const goal = v.goal || 'the operator goal';
    return {
      text: `${active} task(s) are active. Research comes first: assigning the goal to NOVA in the Research Lab.`,
      calls: [['delegate_task', {
        agent_id: 'nova',
        title: `Research: ${clipWords(goal, 90)}`,
        brief: `Operator goal: ${goal}\n\nResearch demand and gaps for this goal: who buys, what they ask for, price bands, and which station room should act. Cite sources.\n\n${ORIGINALITY_RULE}\n\nProduce: a markdown research brief saved with write_file.`,
        artifact_ids: [],
      }]],
    };
  }
  if (delegated.result?.isError) return { text: `I could not assign the research: ${delegated.result.text}` };
  return { text: `Goal received. NOVA has research task ${delegated.result.json?.task_id ?? '(id unavailable)'}; I will review the brief when it returns and decide the next room.` };
}

const orion = script((v) => {
  const reviewing = v.task.kind === 'review' || Boolean(v.task.recipeRunId) || v.inputIds.length > 0;
  if (!reviewing) return goalFlow(v);
  return readInputs(v) || reviewFlow(v);
});

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

const tally = script((v) => {
  const synced = v.last('sync_connector');
  if (!synced) return { text: 'Syncing the Etsy connector before reading the books.', calls: [['sync_connector', { connector: 'etsy' }]] };
  const read = v.last('read_ledger');
  if (!read) return { text: 'Reading the ledger by provenance.', calls: [['read_ledger', {}]] };
  const ledger = read.result?.json;
  if (read.result?.isError || !ledger) return { text: failure('I could not read the ledger', read) };
  const t = ledger.totals;
  const coverage = ledger.evidence_coverage === null ? 'n/a (nothing counted yet)' : `${Math.round(ledger.evidence_coverage * 100)}%`;
  const syncLine = synced.result?.isError ? `Connector sync: not done (${synced.result.text}).` : `Connector sync: ${synced.result.text}`;
  const report = [
    '# Ledger report',
    '',
    `> ${SCRIPTED_NOTICE}. The figures below are read from the ledger, not invented.`,
    '',
    syncLine,
    '',
    `- Verified revenue (connector): ${money(t.verified_revenue_usd)} over ${t.verified_orders} order(s)`,
    `- Operator-entered revenue: ${money(t.operator_revenue_usd)} over ${t.operator_orders} order(s)`,
    `- Agent claims (never counted): ${money(t.claimed_revenue_usd)}`,
    `- Fees ${money(t.fees_usd)}, costs ${money(t.costs_usd)}, net counted ${money(t.net_counted_usd)}`,
    `- Evidence coverage: ${coverage}`,
    `- Runtime spend: ${money(ledger.runtime_spend_usd.today)} today, ${money(ledger.runtime_spend_usd.total)} total`,
    t.claimed_revenue_usd > 0 && t.verified_revenue_usd === 0 ? '- Gap: claims exist with no verified revenue behind them.' : '',
  ].filter((line) => line !== '').join('\n');
  if (!v.last('memory_write')) return { text: 'Filing the report in the Ops archive.', calls: [['memory_write', { key: 'ledger-report', content: report }]] };
  return { text: `${report}\n\nSaved to Ops memory as ledger-report. Artifacts: none (Ops has no workbench).` };
});

/** Scripts keyed by agent id, for createScriptedProvider({scripts: DEFAULT_SCRIPTS}). */
export const DEFAULT_SCRIPTS = Object.freeze({ orion, nova, vega, pixel, quill, flux, tally });
