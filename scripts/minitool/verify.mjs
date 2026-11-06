import { chromium } from 'playwright-core';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const out = 'output/playwright/minitool-v2';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const reports = [];
try {
  for (const [width, height] of [[320,568],[390,844],[430,932],[568,320]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
    // Include left and bottom native safe-area insets, including landscape.
    await context.addInitScript(() => { window.xhs = { launchOptions: { miniToolEnv: { buildVersion: 9510000 } }, miniTool: { getWindowInfo: async () => ({ windowWidth: innerWidth, windowHeight: innerHeight, safeArea: { top: 44, left: 24, right: innerWidth, bottom: innerHeight - 34 }, menuButtons: { me: { left: innerWidth / 2 - 25, right: innerWidth / 2 + 25, top: 44, bottom: 84 } } }) } }; });
    const page = await context.newPage(), errors = [], external = [], missing = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
    page.on('request', r => { if (!r.url().startsWith('http://localhost:5176/') && !r.url().startsWith('data:')) external.push(r.url()); });
    page.on('response', r => { if (r.status() >= 400) missing.push(r.url()); });
    await page.goto('http://localhost:5176/nested/app/');
    await page.waitForFunction(() => window.__almond);
    await page.waitForTimeout(1700);
    const button = page.getByRole('button', { name: '再来一次' });
    const bounds = await button.boundingBox();
    assert.equal(bounds.x, 40); assert.equal(height - bounds.y - bounds.height, 50);
    await page.screenshot({ path: `${out}/${width}-initial.png` });
    const cdp = await context.newCDPSession(page);
    const touch = async (type,x,y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x,y,id:1,radiusX:5,radiusY:5,force:.65 }] });
    const startY = Math.max(height * .32, 150);
    await touch('touchStart',width*.5,startY);
    for (let i=1;i<=40;i++) { await touch('touchMove',width*.5,startY+(height*.93-startY)*i/40); await page.waitForTimeout(22); if (i===16) await page.screenshot({ path: `${out}/${width}-half.png` }); }
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/${width}-full.png` });
    await touch('touchEnd');
    const pulled = await page.evaluate(() => window.__almond.state());
    assert.ok(pulled.maxOpen > .01, 'touch must deform cloth');
    assert.ok(await page.evaluate(() => Array.from(window.__almond.curtain.pos).every(Number.isFinite)));
    await button.tap();
    const reset = await page.evaluate(() => window.__almond.state());
    assert.equal(reset.tornEdges, 0); assert.equal(reset.bloomed, 0); assert.equal(reset.petalsOnLinen, 0); assert.ok(reset.maxOpen < .02);
    for (let i=0;i<3;i++) { await button.tap(); await page.waitForTimeout(100); }
    const budget = await page.evaluate(() => { const r = window.__almond.renderer; return { dpr: r.getPixelRatio(), pixels: r.domElement.width*r.domElement.height, calls:r.info.render.calls, triangles:r.info.render.triangles, memory:r.info.memory }; });
    assert.ok(budget.dpr <= 1.5 && budget.pixels <= 2000001); assert.ok(budget.triangles <= 100000);
    assert.deepEqual(errors,[]); assert.deepEqual(external,[]); assert.deepEqual(missing,[]);
    reports.push({ width,height,pulled,reset,budget,errors,external,missing });
    if (width === 390) {
      await page.evaluate(() => (window.__loss = window.__almond.renderer.getContext().getExtension('WEBGL_lose_context')).loseContext());
      await page.waitForFunction(() => document.body.classList.contains('context-lost'));
      await page.evaluate(() => window.__loss.restoreContext());
      await page.waitForFunction(() => !document.body.classList.contains('context-lost'));
      await page.evaluate(() => window.__almond.renderer.getContext().getExtension('WEBGL_lose_context').loseContext());
      await page.waitForSelector('#simple-canvas');
      await button.tap();
      await page.screenshot({ path: `${out}/repeated-context-loss.png` });
      reports.push({ repeatedContextLoss: 'PASS' });
    }
    await context.close();
  }
  const context = await browser.newContext({ viewport:{width:390,height:844},hasTouch:true,isMobile:true });
  await context.addInitScript(() => { const get=HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext=function(type,...args){ if(type.startsWith('webgl')) return null; return get.call(this,type,...args); }; });
  const page = await context.newPage();
  await page.goto('http://localhost:5176/nested/app/'); await page.waitForSelector('#simple-canvas');
  await page.getByRole('button',{name:'再来一次'}).tap();
  await page.screenshot({path:`${out}/no-webgl.png`});
  reports.push({ noWebGL: 'PASS' }); await context.close();
} finally { await browser.close(); fs.writeFileSync(`${out}/report.json`,JSON.stringify(reports,null,2)); }
console.log(JSON.stringify(reports,null,2));
