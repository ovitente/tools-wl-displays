// End-to-end test for the Displays frontend.
//
// Serves the built dist/, opens it in headless Chrome (puppeteer-core, using the
// system google-chrome-stable), stubs the Go backend (window.go) with a fixture
// monitor set, then drives the real UI: asserts the initial render, toggles an
// output, changes a mode, clicks Apply (capturing the payload sent to the
// backend), exercises the confirm/revert countdown, drags a monitor to verify
// snap-on-drop adjacency and canvas containment, and screenshots each step.
//
// Run: node tests/run.mjs   (inside nix-shell, after building dist)
// Exit code 0 = all assertions passed.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { FIXTURE } from './fixtures.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dir, '..', 'frontend', 'dist');
const SHOTS = resolve(__dir, 'screenshots');
const CHROME = process.env.CHROME ||
  '/nix/store/a4150izcgbmvsdns1akgi17lspx6hhgq-google-chrome-148.0.7778.178/bin/google-chrome-stable';
const PORT = 5599;

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.woff2':'font/woff2', '.png':'image/png', '.svg':'image/svg+xml' };

// ---------- tiny assert harness ----------
let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail='') {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---------- static server for dist/ ----------
function serve() {
  return new Promise((res) => {
    const srv = http.createServer(async (req, rq) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = join(DIST, p);
      if (!file.startsWith(DIST) || !existsSync(file)) { rq.writeHead(404); rq.end('nf'); return; }
      const buf = await readFile(file);
      rq.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      rq.end(buf);
    });
    srv.listen(PORT, () => res(srv));
  });
}

// ---------- backend stub injected before any page script ----------
function stubScript(fixture) {
  return `
    window.__calls = { apply: [], confirm: 0, revert: 0, quit: false };
    window.__testRevertSecs = 2;   // shrink the 10s revert countdown
    const FIX = ${JSON.stringify(fixture)};
    const clone = o => JSON.parse(JSON.stringify(o));
    window.go = { main: { App: {
      GetMonitors: () => Promise.resolve(clone(FIX)),
      // Emulate the backend: echo back what was applied (as Hyprland would,
      // after re-reading state).
      Apply: (mons) => { window.__calls.apply.push(clone(mons)); return Promise.resolve(clone(mons)); },
      ConfirmApply: () => { window.__calls.confirm++; return Promise.resolve(); },
      // Revert restores the pre-Apply state — for the stub, the fixture.
      RevertApply: () => { window.__calls.revert++; return Promise.resolve(clone(FIX)); },
    }}};
    window.runtime = { Quit: () => { window.__calls.quit = true; } };
  `;
}

// ---------- adjacency oracle (mirrors the app's logical-dims invariant) ----------
const L = m => ({ x: m.x, y: m.y, w: Math.round(m.w/(m.scale||1)), h: Math.round(m.h/(m.scale||1)) });
const xov = (a,b) => Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x);
const yov = (a,b) => Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y);
const ovl = (a,b) => xov(a,b) > 0 && yov(a,b) > 0;
const tch = (a,b) => (xov(a,b) > 0 && (a.y+a.h === b.y || b.y+b.h === a.y)) ||
                     (yov(a,b) > 0 && (a.x+a.w === b.x || b.x+b.w === a.x));
function contiguous(mons) {
  const rs = mons.filter(m => m.active).map(L);
  if (rs.length <= 1) return true;
  for (let i = 0; i < rs.length; i++)
    for (let j = i+1; j < rs.length; j++)
      if (ovl(rs[i], rs[j])) return false;
  const seen = new Set([0]), q = [0];
  while (q.length) {
    const i = q.pop();
    rs.forEach((r, j) => { if (!seen.has(j) && tch(rs[i], r)) { seen.add(j); q.push(j); } });
  }
  return seen.size === rs.length;
}

// All canvas monitors fully inside the canvas (small tolerance for borders).
async function assertContained(page, name) {
  const bad = await page.evaluate(() => {
    const c = document.querySelector('#canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.canvas .mon')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.left < c.left - 2 || r.top < c.top - 2 || r.right > c.right + 2 || r.bottom > c.bottom + 2;
    }).length;
  });
  check(name, bad === 0, `${bad} monitors overflow the canvas`);
}

// Drag the named monitor tile with the mouse (pointer events).
async function dragMon(page, name, dx, dy) {
  const from = await page.evaluate(n => {
    const el = [...document.querySelectorAll('.canvas .mon')]
      .find(e => e.querySelector('.mn-name')?.textContent.trim() === n);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  }, name);
  if (!from) throw new Error(`monitor tile ${name} not found`);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++)
    await page.mouse.move(from.x + dx*i/6, from.y + dy*i/6);
  await page.mouse.up();
  await new Promise(r => setTimeout(r, 150));
}

const text = (page, sel) => page.$eval(sel, el => el.textContent.trim()).catch(() => null);

async function main() {
  if (!existsSync(DIST)) { console.error('dist/ missing — build first'); process.exit(2); }
  const srv = await serve();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 980, height: 760 });
  const consoleErrors = [];
  const failedUrls = [];
  // Ignore the browser's automatic /favicon.ico probe — not an app asset.
  const ignore = u => /favicon\.ico/.test(u || '');
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const url = (m.location && m.location().url) || '';
    if (ignore(m.text()) || ignore(url)) return;
    // Generic resource-load failures are authoritatively covered by failedUrls.
    if (/Failed to load resource/.test(m.text()) && !url) return;
    consoleErrors.push(m.text());
  });
  page.on('pageerror', e => consoleErrors.push(String(e)));
  page.on('requestfailed', r => { if (!ignore(r.url())) failedUrls.push(r.url()); });
  page.on('response', r => { if (r.status() >= 400 && !ignore(r.url())) failedUrls.push(`${r.status()} ${r.url()}`); });

  await page.evaluateOnNewDocument(stubScript(FIXTURE));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });

  // ---- 1. initial render ----
  await page.waitForSelector('.row', { timeout: 5000 }).catch(() => {});
  const rows = await page.$$eval('.row', els => els.length);
  const mons = await page.$$eval('.canvas .mon', els => els.length);
  check('3 output rows rendered', rows === 3, `got ${rows}`);
  check('3 monitors on canvas', mons === 3, `got ${mons}`);
  check('list meta = "3 detected"', (await text(page, '#list-meta')) === '3 detected', await text(page, '#list-meta'));
  check('footer = "3 of 3 outputs active"', /3.*of.*3/.test(await text(page, '#foot-note') || ''));
  check('primary pill on a row', (await page.$$eval('.row .pill', e => e.length)) === 1);
  check('fonts: Chakra Petch applied to brand', await page.$eval('.brand', el =>
    getComputedStyle(el).fontFamily.toLowerCase().includes('chakra')));
  await page.screenshot({ path: join(SHOTS, '01-initial.png') });

  // ---- 2. toggle HDMI-A-1 off ----
  await page.click('[data-sw="HDMI-A-1"]');
  await new Promise(r => setTimeout(r, 200));
  const hdmiDis = await page.$eval('.row[data-name="HDMI-A-1"]', el => el.classList.contains('dis'));
  const hdmiSwOff = await page.$eval('.row[data-name="HDMI-A-1"] .sw', el => !el.classList.contains('on'));
  check('HDMI-A-1 row marked disabled', hdmiDis);
  check('HDMI-A-1 switch is off', hdmiSwOff);
  check('footer now "2 of 3"', /2.*of.*3/.test(await text(page, '#foot-note') || ''), await text(page, '#foot-note'));
  await page.screenshot({ path: join(SHOTS, '02-toggle-off.png') });

  // ---- 3. change eDP-1 resolution ----
  await page.select('.row[data-name="eDP-1"] select[data-fld="res"]', '1920×1200');
  await new Promise(r => setTimeout(r, 150));
  const edpRes = await page.$eval('.row[data-name="eDP-1"] select[data-fld="res"]', el => el.value);
  check('eDP-1 resolution select = 1920×1200', edpRes === '1920×1200', edpRes);
  const edpCanvasSub = await page.$eval('.canvas .mon.sel .mn-res', el => el.textContent.trim()).catch(() => '');
  check('eDP-1 canvas label reflects new resolution', edpCanvasSub.includes('1920×1200'), edpCanvasSub);

  // ---- 4. change eDP-1 scale ----
  await page.select('.row[data-name="eDP-1"] select[data-fld="scale"]', '2');
  await new Promise(r => setTimeout(r, 150));
  const toastScale = await text(page, '#toast');
  check('scale change toast shown', /scale 2/.test(toastScale || ''), toastScale);

  // ---- 5. Apply → payload sent, confirm dialog opens, Keep persists ----
  await page.click('[data-act="apply"]');
  await new Promise(r => setTimeout(r, 300));
  const calls = await page.evaluate(() => window.__calls.apply);
  check('Apply called backend once', calls.length === 1, `calls=${calls.length}`);
  if (calls.length) {
    const payload = calls[0];
    const hdmi = payload.find(m => m.name === 'HDMI-A-1');
    const edp = payload.find(m => m.name === 'eDP-1');
    check('Apply payload: HDMI-A-1 active=false', hdmi && hdmi.active === false);
    check('Apply payload: eDP-1 w=1920 h=1200', edp && edp.w === 1920 && edp.h === 1200, JSON.stringify(edp && {w:edp.w,h:edp.h}));
    check('Apply payload: eDP-1 scale=2', edp && edp.scale === 2, String(edp && edp.scale));
    check('Apply payload: layout gap-free and connected', contiguous(payload),
      JSON.stringify(payload.filter(m => m.active).map(m => ({n:m.name,...L(m)}))));
  }
  const modalShown = await page.$eval('#confirm', el => !el.hidden);
  check('confirm dialog opens after Apply', modalShown);
  const cd0 = parseInt(await text(page, '#cd'), 10);
  check('countdown is ticking', cd0 >= 1 && cd0 <= 2, `cd=${cd0}`);
  await page.screenshot({ path: join(SHOTS, '03-applied.png') });
  await page.click('[data-mact="keep"]');
  await new Promise(r => setTimeout(r, 150));
  check('Keep → ConfirmApply called once', (await page.evaluate(() => window.__calls.confirm)) === 1);
  check('Keep → dialog hidden', await page.$eval('#confirm', el => el.hidden));
  check('Keep → toast "Configuration applied"', /Configuration applied/.test(await text(page, '#toast') || ''), await text(page, '#toast'));

  // ---- 5b. responsive: card fills the window, monitors never overflow ----
  for (const [w, h] of [[1400, 900], [760, 560]]) {
    await page.setViewport({ width: w, height: h });
    await new Promise(r => setTimeout(r, 180));
    const winW = await page.$eval('.win', el => el.clientWidth);
    const winH = await page.$eval('.win', el => el.clientHeight);
    check(`card fills width @${w}×${h}`, Math.abs(winW - w) <= 4, `winW=${winW}`);
    check(`card fills height @${w}×${h}`, Math.abs(winH - h) <= 4, `winH=${winH}`);
    await assertContained(page, `monitors inside canvas @${w}×${h}`);
  }
  await page.setViewport({ width: 1400, height: 900 });
  await new Promise(r => setTimeout(r, 150));
  await page.screenshot({ path: join(SHOTS, '04-resized.png') });

  // ---- 6. drag → snap-on-drop keeps the layout contiguous ----
  await dragMon(page, 'eDP-1', 260, -160);
  await assertContained(page, 'monitors inside canvas after drag');
  await page.click('[data-act="apply"]');
  await new Promise(r => setTimeout(r, 300));
  const calls2 = await page.evaluate(() => window.__calls.apply);
  check('drag Apply called', calls2.length === 2, `calls=${calls2.length}`);
  if (calls2.length === 2)
    check('dragged layout gap-free and connected', contiguous(calls2[1]),
      JSON.stringify(calls2[1].filter(m => m.active).map(m => ({n:m.name,...L(m)}))));
  await page.screenshot({ path: join(SHOTS, '05-dragged.png') });

  // ---- 7. Revert now: canvas returns to the pre-Apply (fixture) state ----
  await page.click('[data-mact="revert"]');
  await new Promise(r => setTimeout(r, 200));
  check('Revert now → RevertApply called', (await page.evaluate(() => window.__calls.revert)) === 1);
  check('Revert now → dialog hidden', await page.$eval('#confirm', el => el.hidden));
  const edpPos = await text(page, '.row[data-name="eDP-1"] .r-pos b');
  check('Revert now → eDP-1 back at fixture position', edpPos === '700,2160', edpPos);

  // ---- 8. auto-revert when the countdown expires ----
  await page.click('[data-act="apply"]');
  await new Promise(r => setTimeout(r, 300));
  check('3rd Apply opens dialog', await page.$eval('#confirm', el => !el.hidden));
  await new Promise(r => setTimeout(r, 2600));
  check('countdown expiry → RevertApply called', (await page.evaluate(() => window.__calls.revert)) === 2);
  check('countdown expiry → dialog hidden', await page.$eval('#confirm', el => el.hidden));

  // ---- 9. single active monitor pins to 0,0 ----
  // Auto-revert restored the fixture (all three active) — leave only DP-1 on.
  await page.click('[data-sw="HDMI-A-1"]');
  await new Promise(r => setTimeout(r, 120));
  await page.click('[data-sw="eDP-1"]');
  await new Promise(r => setTimeout(r, 120));
  await dragMon(page, 'DP-1', 180, 90);
  await page.click('[data-act="apply"]');
  await new Promise(r => setTimeout(r, 300));
  const calls4 = await page.evaluate(() => window.__calls.apply);
  const dpLast = calls4.length ? calls4[calls4.length - 1].find(m => m.name === 'DP-1') : null;
  check('single active monitor pinned to 0,0', dpLast && dpLast.x === 0 && dpLast.y === 0,
    JSON.stringify(dpLast && {x:dpLast.x, y:dpLast.y}));

  // ---- 10. Esc: with dialog open = revert; without = quit ----
  const revBefore = await page.evaluate(() => window.__calls.revert);
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 200));
  check('Esc with dialog → RevertApply, not Quit',
    (await page.evaluate(() => window.__calls.revert)) === revBefore + 1 &&
    !(await page.evaluate(() => window.__calls.quit)));
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 100));
  check('Esc without dialog → Quit', await page.evaluate(() => window.__calls.quit));

  // ---- 11. no console errors / no broken assets ----
  check('no console/page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  check('no failed asset requests', failedUrls.length === 0, failedUrls.join(' | '));

  await browser.close();
  srv.close();

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`screenshots: ${SHOTS}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
