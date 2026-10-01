// SVG sanitizer: every SVG an agent produces passes through here before it becomes an artifact.
//
// Artifacts are served with a strict CSP and shown through <img>, so in the app this is defence in
// depth. It is the only defence once a file leaves the app (a delivery hand-off, a download opened
// directly), so it must hold on its own: an SVG that could run script, pull a remote resource or
// smuggle markup is refused outright rather than "cleaned", because a design the operator did not
// see exactly is not a design. Checks work on names, not just literal tags: elements must be on an
// SVG allow-list, no namespace prefix or foreign namespace is accepted, any href/src (any prefix)
// must be #id or an embedded raster, and CSS escapes are refused so url()/@import cannot hide.

export const MAX_SVG_BYTES = 512 * 1024;
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// The SVG elements a design may use (compared case-insensitively). Everything else is refused,
// whatever its case or namespace: script, foreignObject, and any XHTML element (img, iframe, meta,
// ...) that a namespace declaration could smuggle into the document.
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'image', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'title', 'desc', 'lineargradient', 'radialgradient', 'stop', 'pattern', 'clippath',
  'mask', 'filter', 'marker', 'style', 'a', 'set', 'animate', 'animatetransform', 'animatemotion', 'mpath', 'switch',
  'metadata', 'view',
]);
const FILTER_PRIMITIVE = /^fe[a-z]+$/i; // feGaussianBlur, feImage (its href is checked like any other), ...

const FORBIDDEN = [
  [/<\s*\/?\s*[A-Za-z_][\w.-]*:/, 'namespace-prefixed elements are not allowed'],
  [/<script\b/i, '<script> is not allowed'],
  [/<foreignObject\b/i, '<foreignObject> is not allowed'],
  [/<(iframe|embed|object)\b/i, 'embedded documents are not allowed'],
  [/<!ENTITY/i, 'entity declarations are not allowed'],
  [/<!DOCTYPE/i, 'DOCTYPE declarations are not allowed'],
  [/<\?xml-stylesheet/i, 'external stylesheets are not allowed'],
  [/@import/i, '@import is not allowed'],
  [/[\s/"'](?:[\w.-]+:)?on[a-z-]+\s*=/i, 'event handler attributes (on*=) are not allowed'],
  [/attributeName\s*=\s*["']?\s*(?:[\w.-]+:)?(?:href|src|on)/i, 'animating href, src or event handlers is not allowed'],
  // CSS escapes (u\72l(, @\69mport) would disguise everything the checks below look for.
  [/\\/, 'backslashes are not allowed (CSS escapes can disguise url() and @import)'],
  [/(?:-webkit-)?image-set\s*\(|\bsrc\s*\(/i, 'image-set() and src() are not allowed'],
  [/[\s/"']xml:base\s*=/i, 'xml:base is not allowed (it re-targets references)'],
];

/** Decode numeric and the common named character references so obfuscated payloads are caught. */
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16) % 0x110000))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Number(dec) % 0x110000))
    .replace(/&(colon|tab|newline|lpar|rpar);/gi, (_, name) => ({ colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')' })[name.toLowerCase()]);
}

const isSafeRef = (value) => value.startsWith('#') || /^data:image\/(png|jpeg|webp)[;,]/i.test(value);
const unquote = (v) => v.replace(/^(["'])([\s\S]*)\1$/, '$2');

function checkReferences(text) {
  // Any prefix (x1:href, q.1:href, ...) and src as well as href: only #id or an embedded raster.
  for (const m of text.matchAll(/(?:^|[\s/"'])(?:[\w.-]+:)?(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = (m[1] ?? m[2] ?? m[3]).trim();
    if (!isSafeRef(value)) return `href/src must point inside the document (#id) or be an embedded png/jpeg/webp, got "${value.slice(0, 60)}"`;
  }
  for (const m of text.matchAll(/url\s*\(\s*["']?\s*([^)"']*)/gi)) {
    if (!m[1].trim().startsWith('#')) return `url() may only reference elements in the document (#id), got "${m[1].slice(0, 60)}"`;
  }
  return null;
}

/** Namespace declarations: only SVG as the default and xlink as the one prefix. */
function checkNamespaces(text) {
  for (const m of text.matchAll(/\sxmlns\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi)) {
    if (unquote(m[1]) !== SVG_NS) return `only the SVG namespace may be the default namespace, got "${unquote(m[1]).slice(0, 60)}"`;
  }
  for (const m of text.matchAll(/\sxmlns:([^\s=>]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi)) {
    if (m[1] !== 'xlink' || unquote(m[2]) !== XLINK_NS) return `namespace declaration xmlns:${m[1].slice(0, 30)} is not allowed (only xmlns:xlink="${XLINK_NS}")`;
  }
  return null;
}

/** Every element must be an allowed SVG element (comments and CDATA hold no elements). */
function checkElements(text) {
  const markup = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  for (const m of markup.matchAll(/<\s*([A-Za-z_][\w.-]*)/g)) {
    if (!ALLOWED_ELEMENTS.has(m[1].toLowerCase()) && !FILTER_PRIMITIVE.test(m[1])) return `<${m[1].slice(0, 40)}> is not an allowed SVG element`;
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
    const problem = checkReferences(text) ?? checkNamespaces(text);
    if (problem) return fail(problem);
  }
  // On the raw text only: a character reference never creates an element.
  const elementProblem = checkElements(svg);
  if (elementProblem) return fail(elementProblem);

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
