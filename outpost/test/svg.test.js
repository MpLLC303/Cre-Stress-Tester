import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SVG_BYTES, sanitizeSvg } from '../sidecar/svg.js';

const NS = 'xmlns="http://www.w3.org/2000/svg"';
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
