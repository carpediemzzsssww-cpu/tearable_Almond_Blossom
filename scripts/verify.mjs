// Playwright + local Chrome: real pointer drags through the key states, desktop + phone.
// usage: node scripts/verify.mjs [baseUrl] [outDir]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://localhost:5188/';
const out = process.argv[3] || 'docs/screens';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const views = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, dpr: 1, touch: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, dpr: 2, touch: true },
];
// CDP generates browser touch input (and the corresponding PointerEvents),
// unlike page.mouse on a context that merely advertises hasTouch.
async function pointerFor(page, context, touch) {
  const cdp = touch ? await context.newCDPSession(page) : null;
  const point = (x, y) => ({ x, y, id: 1, radiusX: 5, radiusY: 5, force: 0.65 });
  return {
    async down(x, y) {
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(x, y)] });
      else {
        await page.mouse.move(x, y);
        await page.mouse.down();
      }
    },
    async move(x, y) {
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(x, y)] });
      else await page.mouse.move(x, y);
    },
    async up() {
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      else await page.mouse.up();
    },
  };
}
const drag = async (page, pointer, x, y, dy, steps, pause) => {
  await pointer.down(x, y);
  for (let i = 1; i <= steps; i++) {
    await pointer.move(x, y + (dy * i) / steps);
    await page.waitForTimeout(pause);
  }
};
try {
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: v.dpr, hasTouch: v.touch, isMobile: v.touch });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(() => {
    window.__verifyPointerTypes = [];
    addEventListener('pointerdown', (event) => window.__verifyPointerTypes.push(event.pointerType));
  });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__almond);
  const pointer = await pointerFor(page, ctx, v.touch);
  const healthy = async (stage) => {
    const finite = await page.evaluate(() => Array.from(window.__almond.curtain.pos).every(Number.isFinite));
    assert.ok(finite, `${v.name}/${stage}: non-finite cloth position`);
    assert.deepEqual(errors, [], `${v.name}/${stage}: browser errors`);
  };
  await page.waitForTimeout(1800);
  await healthy('initial');
  const initialExposedFlowers = await page.evaluate(() => {
    const { curtain, tree, camera } = window.__almond;
    const p = camera.position.clone();
    return tree.blooms.filter((b) => {
      if (b.type !== 0) return false;
      p.set(b.x, b.y, b.z).project(camera);
      if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || p.z < -1 || p.z > 1) return false;
      // Match the app's camera-to-cloth projection; world y alone is insufficient.
      const k = (camera.position.z - curtain.o.z0) / (camera.position.z - b.z);
      const hz = curtain.hf.sample(b.x * k, b.y * k);
      return Number.isNaN(hz) || b.z > hz + 0.005;
    }).length;
  });
  assert.equal(initialExposedFlowers, 0, `${v.name}: flowers visible in front of the initial curtain`);
  await page.screenshot({ path: `${out}/${v.name}-1-initial.png` });
  await page.waitForFunction(() => window.__almond.curtain.nudge > 0.95, null, { timeout: 15000 });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${out}/${v.name}-1b-peek.png` });
  await page.waitForFunction(() => window.__almond.curtain.nudge < 0.01, null, { timeout: 15000 });
  const W = v.viewport.width, H = v.viewport.height;
  // Keep the entire finger path on the phone screen, including the full pull.
  const startY = H * (v.touch ? 0.32 : 0.6);
  // slow half pull in the middle, held
  await drag(page, pointer, W * 0.5, startY, H * 0.2, 40, 30);
  await page.waitForTimeout(1600);
  await healthy('half-held');
  await page.screenshot({ path: `${out}/${v.name}-2-half-held.png` });
  const half = await page.evaluate(() => window.__almond.state());
  // continue fast to full
  for (let i = 1; i <= 6; i++) { await pointer.move(W * 0.5, startY + H * 0.2 + (H * 0.42 * i) / 6); await page.waitForTimeout(16); }
  await page.waitForTimeout(220);
  await healthy('wave');
  await page.screenshot({ path: `${out}/${v.name}-3-wave.png` });
  await page.waitForTimeout(1600);
  await healthy('full-held');
  await page.screenshot({ path: `${out}/${v.name}-4-full-held.png` });
  await pointer.up();
  await page.waitForTimeout(2600);
  await healthy('released');
  await page.screenshot({ path: `${out}/${v.name}-5-released.png` });
  // a second, smaller pull off to one side carves another dip
  await drag(page, pointer, W * 0.2, H * 0.72, H * 0.26, 24, 25);
  await pointer.up();
  await page.waitForTimeout(3500);
  await healthy('second-pull');
  await page.screenshot({ path: `${out}/${v.name}-6-second-pull.png` });
  const full = await page.evaluate(() => window.__almond.state());
  const pointerTypes = await page.evaluate(() => window.__verifyPointerTypes);
  assert.deepEqual(pointerTypes, [v.touch ? 'touch' : 'mouse', v.touch ? 'touch' : 'mouse'], `${v.name}: wrong input path`);
  console.log(v.name, JSON.stringify({ half, full, pointerTypes, errors }));
  await ctx.close();
}
} finally {
  await browser.close();
}
