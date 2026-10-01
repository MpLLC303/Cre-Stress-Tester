#!/usr/bin/env node
// UI smoke test: loads the station in Chromium at desktop and phone sizes, opens the main
// terminals, screenshots each state, and fails on any console error, page error, or
// horizontal page scroll.
//
//   node scripts/ui-smoke.mjs <baseUrl> <outDir>
//   e.g. node scripts/ui-smoke.mjs http://127.0.0.1:8790 docs/screenshots
//
// Playwright is resolved from the local install first, then the global one.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [baseUrl, outDirArg] = process.argv.slice(2);
if (!baseUrl || !outDirArg) {
  console.error('usage: node scripts/ui-smoke.mjs <baseUrl> <outDir>');
  process.exit(2);
}
const outDir = resolve(outDirArg);
mkdirSync(outDir, { recursive: true });

async function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs'];
  for (const c of candidates) {
    try {
      return await import(c);
    } catch {
      /* try next */
    }
  }
  throw new Error('playwright not found (npm i -g playwright)');
}

const { chromium } = await loadPlaywright();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

const problems = [];
const shots = [];

async function panelState(page) {
  return page.evaluate(() => {
    const p = document.getElementById('panel');
    return { view: p?.dataset.view || '', id: p?.dataset.id || '' };
  });
}

/** Click a room on the canvas using station.json geometry; fall back to the test hook. */
async function selectRoom(page, roomId, log) {
  const box = await page.locator('#world').boundingBox();
  const target = await page.evaluate((id) => {
    const st = window.__outpost.client.state.station;
    const r = st.rooms.find((x) => x.id === id);
    return r ? { gw: st.grid.w, gh: st.grid.h, cx: r.rect[0] + r.rect[2] / 2, cy: r.rect[1] + r.rect[3] / 2 } : null;
  }, roomId);
  if (box && target) {
    const x = box.x + (target.cx / target.gw) * box.width;
    const y = box.y + (target.cy / target.gh) * box.height;
    await page.mouse.click(x, y);
    await sleep(400);
    const s = await panelState(page);
    if (s.view === 'room' && s.id === roomId) {
      log(`canvas click selected room ${roomId}`);
      return 'canvas';
    }
    log(`canvas click at (${Math.round(x)},${Math.round(y)}) gave ${s.view}:${s.id}; using window.__outpost.ui.open`);
  }
  await page.evaluate((id) => window.__outpost.ui.open({ type: 'room', id }), roomId);
  await sleep(300);
  return 'hook';
}

async function shot(page, vp, name, opts = {}) {
  const file = join(outDir, `${vp.name}-${name}.png`);
  await page.screenshot({ path: file, ...opts });
  shots.push(file);
}

const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    const log = (m) => console.log(`[${vp.name}] ${m}`);
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('requestfailed', (req) => {
      const url = req.url();
      if (url.includes('/api/events')) return; // SSE is torn down on navigation/close
      errors.push(`requestfailed: ${url} ${req.failure()?.errorText || ''}`);
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__outpost && window.__outpost.ui, null, { timeout: 15000 });
    log('station mounted; waiting 6s for live events');
    await sleep(6000);
    await shot(page, vp, '01-overview');

    // horizontal page scroll check
    const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    if (overflow.sw > overflow.cw) problems.push(`[${vp.name}] horizontal page scroll: scrollWidth ${overflow.sw} > clientWidth ${overflow.cw}`);

    // Bridge
    await selectRoom(page, 'bridge', log);
    await shot(page, vp, '02-bridge');
    await page.locator('.panel-body .terminal-title, .panel-body h3.sec-title').filter({ hasText: 'TASK BOARD' }).first().scrollIntoViewIfNeeded().catch(() => {});
    await sleep(150);
    await shot(page, vp, '02b-bridge-taskboard');

    // Ops / ledger
    await selectRoom(page, 'ops', log);
    await page.locator('.panel-body .terminal-title').filter({ hasText: 'LEDGER TERMINAL' }).first().scrollIntoViewIfNeeded().catch(() => {});
    await sleep(200);
    await shot(page, vp, '03-ops-ledger');
    await page.locator('.panel-body .sec-title').filter({ hasText: 'ENTRIES' }).first().scrollIntoViewIfNeeded().catch(() => {});
    await sleep(150);
    await shot(page, vp, '03b-ops-entries');

    // Agent dossier
    await page.evaluate(() => window.__outpost.ui.open({ type: 'agent', id: 'orion' }));
    await sleep(300);
    const agentState = await panelState(page);
    if (agentState.view !== 'agent') problems.push(`[${vp.name}] agent dossier did not open (${agentState.view})`);
    await shot(page, vp, '04-agent-orion');

    // Production gallery
    await selectRoom(page, 'production', log);
    await page.locator('.panel-body .terminal-title').filter({ hasText: 'PRODUCTION TERMINAL' }).first().scrollIntoViewIfNeeded().catch(() => {});
    await sleep(600);
    await shot(page, vp, '05-production');

    // Approvals drawer
    await page.evaluate(() => window.__outpost.ui.open({ type: 'approvals' }));
    await sleep(300);
    await shot(page, vp, '06-approvals');

    // Artifact viewer (first svg if any, else first artifact)
    const artId = await page.evaluate(() => {
      const st = window.__outpost.client.state;
      const ids = [...st.artifactOrder].reverse();
      return ids.find((id) => st.artifacts[id]?.kind === 'svg') || ids[0] || null;
    });
    if (artId) {
      await page.evaluate((id) => window.__outpost.ui.openArtifact(id), artId);
      await sleep(800);
      const dialog = await page.locator('[role="dialog"]').count();
      if (!dialog) problems.push(`[${vp.name}] artifact viewer did not open`);
      await shot(page, vp, '07-artifact');
      await page.keyboard.press('Escape');
      await sleep(200);
      const still = await page.locator('[role="dialog"]').count();
      if (still) problems.push(`[${vp.name}] Esc did not close the artifact viewer`);
    }

    if (vp.name === 'phone') {
      await page.keyboard.press('Escape');
      await sleep(200);
      await shot(page, vp, '08-sheet-closed');
      const overflow2 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      if (overflow2.sw > overflow2.cw) problems.push(`[${vp.name}] horizontal page scroll after interaction: ${overflow2.sw} > ${overflow2.cw}`);
    }

    for (const e of errors) problems.push(`[${vp.name}] ${e}`);
    log(`${errors.length} console/page errors`);
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(`screenshots (${shots.length}):`);
for (const s of shots) console.log(`  ${s}`);
if (problems.length) {
  console.error(`FAIL: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('PASS: zero console errors, no horizontal page scroll');
