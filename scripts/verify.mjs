// Playwright + local Chrome: real pointer drags through the key states, desktop + phone.
// usage: node scripts/verify.mjs [baseUrl] [outDir]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:5188/';
const out = process.argv[3] || 'docs/screens';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const views = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, dpr: 1, touch: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, dpr: 2, touch: true },
];
const drag = async (page, x, y, dy, steps, pause) => {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x, y + (dy * i) / steps);
    await page.waitForTimeout(pause);
  }
};
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: v.dpr, hasTouch: v.touch, isMobile: v.touch });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__almond);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${out}/${v.name}-1-initial.png` });
  await page.waitForFunction(() => window.__almond.curtain.nudge > 0.95, null, { timeout: 15000 });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${out}/${v.name}-1b-peek.png` });
  await page.waitForFunction(() => window.__almond.curtain.nudge < 0.01, null, { timeout: 15000 });
  const W = v.viewport.width, H = v.viewport.height;
  // slow half pull in the middle, held
  await drag(page, W * 0.5, H * 0.6, H * 0.2, 40, 30);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${out}/${v.name}-2-half-held.png` });
  const half = await page.evaluate(() => window.__almond.state());
  // continue fast to full
  for (let i = 1; i <= 6; i++) { await page.mouse.move(W * 0.5, H * 0.6 + H * 0.2 + (H * 0.42 * i) / 6); await page.waitForTimeout(16); }
  await page.waitForTimeout(220);
  await page.screenshot({ path: `${out}/${v.name}-3-wave.png` });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${out}/${v.name}-4-full-held.png` });
  await page.mouse.up();
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${out}/${v.name}-5-released.png` });
  // a second, smaller pull off to one side carves another dip
  await drag(page, W * 0.2, H * 0.72, H * 0.26, 24, 25);
  await page.mouse.up();
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${out}/${v.name}-6-second-pull.png` });
  const full = await page.evaluate(() => window.__almond.state());
  console.log(v.name, JSON.stringify({ half, full, errors }));
  await ctx.close();
}
await browser.close();
