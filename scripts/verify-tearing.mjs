// Focused fracture regressions. The companion verify.mjs covers real mouse/touch.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:5188/';
const out = process.argv[3] || 'output/playwright/tearing';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const reports = [];
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const name = viewport.width < 600 ? 'phone' : 'desktop';
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (e) => e.type() === 'error' && errors.push(e.text()));
    await page.goto(base);
    await page.waitForFunction(() => window.__almond);
    const result = await page.evaluate(() => {
      const a = window.__almond;
      const move = (x, y, frames = 60) => {
        for (let i = 1; i <= frames; i++) { a.pull(x * i / frames, y * i / frames); a.step(1000 / 60); }
      };
      const finite = () => Array.from(a.curtain.pos).every(Number.isFinite);
      a.reset();
      const initial = a.state();
      const picked = a.grab(0.5, 0.3);
      move(0, -0.1);
      const gentle = a.state();
      a.release();
      a.step(1000);
      a.reset();
      const pickedDeep = a.grab(0.5, 0.3);
      move(0, -0.7, 100);
      a.step(500);
      const torn = a.state();
      const finiteTorn = finite();
      move(0.65, -0.9, 100);
      const detached = a.state();
      a.release();
      a.step(6000);
      const settled = a.state();
      return { initial, picked, gentle, pickedDeep, torn, detached, settled, finiteTorn, finiteSettled: finite() };
    });
    assert.ok(result.picked && result.pickedDeep, `${name}: failed to grab visible cloth`);
    assert.equal(result.initial.tornEdges, 0, `${name}: initial cloth damaged`);
    assert.equal(result.gentle.tornEdges, 0, `${name}: a gentle pull must not tear`);
    assert.ok(result.torn.tornEdges > 0, `${name}: sustained deep pull did not tear`);
    assert.ok(result.detached.detachedPieces > 0, `${name}: sideways tug did not detach the flap`);
    assert.ok(result.settled.clothParticles < result.detached.clothParticles, `${name}: offscreen scrap was not retired`);
    assert.ok(result.finiteTorn && result.finiteSettled, `${name}: unstable cloth positions`);
    assert.ok(result.settled.bloomed > result.initial.bloomed, `${name}: opening did not reveal blossoms`);
    await page.screenshot({ path: `${out}/${name}-torn-settled.png` });
    const stress = await page.evaluate(() => {
      const a = window.__almond;
      let grabs = 0;
      for (const [x, y] of [[0.24, 0.48], [0.76, 0.45], [0.35, 0.65], [0.65, 0.68], [0.5, 0.72]]) {
        if (!a.grab(x, y)) continue;
        grabs++;
        for (let i = 1; i <= 90; i++) { a.pull((x < 0.5 ? -0.5 : 0.5) * i / 90, -0.8 * i / 90); a.step(1000 / 60); }
        a.release();
        a.step(3000);
      }
      return { grabs, state: a.state(), finite: Array.from(a.curtain.pos).every(Number.isFinite), capacity: a.curtain.capacity, count: a.curtain.n };
    });
    assert.ok(stress.grabs > 0 && stress.finite, `${name}: repeated tearing failed`);
    assert.ok(stress.count <= stress.capacity, `${name}: fracture exceeded its particle budget`);
    await page.screenshot({ path: `${out}/${name}-repeated-tears.png` });
    assert.deepEqual(errors, [], `${name}: browser errors`);
    reports.push({ name, ...result, stress, errors });
    console.log(name, JSON.stringify({ ...result, stress }));
    await ctx.close();
  }
  fs.writeFileSync(`${out}/report.json`, JSON.stringify(reports, null, 2));
} finally {
  await browser.close();
}
