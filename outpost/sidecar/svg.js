// SVG sanitizer: every SVG an agent produces passes through here before it becomes an artifact.
//
// Artifacts are served with a strict CSP and shown through <img>, so this is defence in depth:
// an SVG that could run script, pull a remote resource or smuggle markup is refused outright
// rather than "cleaned", because a design the operator did not see exactly is not a design.

export const MAX_SVG_BYTES = 512 * 1024;
const SVG_NS = 'http://www.w3.org/2000/svg';

const FORBIDDEN = [
  [/<script\b/i, '<script> is not allowed'],
  [/<foreignObject\b/i, '<foreignObject> is not allowed'],
  [/<(iframe|embed|object)\b/i, 'embedded documents are not allowed'],
  [/<!ENTITY/i, 'entity declarations are not allowed'],
  [/<!DOCTYPE/i, 'DOCTYPE declarations are not allowed'],
  [/<\?xml-stylesheet/i, 'external stylesheets are not allowed'],
  [/@import/i, '@import is not allowed'],
  [/[\s/"']on[a-z-]+\s*=/i, 'event handler attributes (on*=) are not allowed'],
  [/attributeName\s*=\s*["']?(?:xlink:)?href/i, 'animating href is not allowed'],
];

/** Decode numeric and the common named character references so obfuscated payloads are caught. */
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16) % 0x110000))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Number(dec) % 0x110000))
    .replace(/&(colon|tab|newline|lpar|rpar);/gi, (_, name) => ({ colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')' })[name.toLowerCase()]);
}

const isSafeRef = (value) => value.startsWith('#') || /^data:image\/(png|jpeg|webp)[;,]/i.test(value);

function checkReferences(text) {
  for (const m of text.matchAll(/(?:^|[\s/"'])(?:[a-z-]+:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = (m[1] ?? m[2] ?? m[3]).trim();
    if (!isSafeRef(value)) return `href must point inside the document (#id) or be an embedded png/jpeg/webp, got "${value.slice(0, 60)}"`;
  }
  for (const m of text.matchAll(/url\s*\(\s*["']?\s*([^)"']*)/gi)) {
    if (!m[1].trim().startsWith('#')) return `url() may only reference elements in the document (#id), got "${m[1].slice(0, 60)}"`;
  }
  return null;
}

/** Strip the XML prolog and comments around the root so we can see what the root element is. */
function rootBounds(svg) {
  const lead = svg.match(/^(?:\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->)*/)[0].length;
  const tail = svg.match(/(?:\s|<!--[\s\S]*?-->)*$/)[0].length;
  return { lead, end: svg.length - tail };
}

/**
 * Validate an agent-produced SVG document.
 * @param {string} svg
 * @returns {{ok:boolean, svg:string|null, reason:string}} the (possibly xmlns-completed) SVG when ok
 */
export function sanitizeSvg(svg) {
  const fail = (reason) => ({ ok: false, svg: null, reason });
  if (typeof svg !== 'string') return fail('svg must be a string');
  if (Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) return fail(`svg exceeds ${MAX_SVG_BYTES / 1024} KB`);
  if (!/<svg\b/.test(svg)) return fail('missing <svg> root element');

  const decoded = decodeEntities(svg);
  for (const text of [svg, decoded]) {
    for (const [pattern, reason] of FORBIDDEN) if (pattern.test(text)) return fail(reason);
    if (/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(text)) return fail('javascript: URLs are not allowed');
    const refProblem = checkReferences(text);
    if (refProblem) return fail(refProblem);
  }

  const { lead, end } = rootBounds(svg);
  if (!/^<svg[\s>]/.test(svg.slice(lead, lead + 5))) return fail('the root element must be <svg>');
  if (!svg.slice(0, end).endsWith('</svg>')) return fail('the document must end with </svg>');

  const openEnd = svg.indexOf('>', lead);
  const openTag = svg.slice(lead, openEnd);
  const ns = openTag.match(/\sxmlns\s*=\s*["']([^"']*)["']/);
  if (ns && ns[1] !== SVG_NS) return fail(`root xmlns must be ${SVG_NS}`);
  const out = ns ? svg : `${svg.slice(0, lead + 4)} xmlns="${SVG_NS}"${svg.slice(lead + 4)}`;
  return { ok: true, svg: out, reason: '' };
}
