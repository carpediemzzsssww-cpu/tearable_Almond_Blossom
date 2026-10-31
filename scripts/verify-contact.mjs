// Cloth-to-cloth regression, independent of the real-input smoke test.
// Usage: node scripts/verify-contact.mjs [baseUrl] [outDir]
// Uses the simulation hooks; does not claim to validate physical phone input.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:5188/';
const out = process.argv[3] || 'output/playwright/contact';
const limits = { maxPenetration: 0.001, gapDeficit: 0.005, maxRenderPenetration: 0.003 };
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const reports = [], failures = [];
const writeReport = () => fs.writeFileSync(`${out}/report.json`, JSON.stringify({ limits, reports, failures }, null, 2));

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const name = viewport.width < 600 ? 'phone' : 'desktop';
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: name === 'phone', isMobile: name === 'phone' });
    const page = await context.newPage();
    const errors = [], report = { name, viewport, stages: [], errors };
    reports.push(report);
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
    let stageNumber = 0;
    try {
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__almond?.curtain?.collisionStats && window.__almond.curtain.surface);
      await page.evaluate((thresholds) => {
        const a = window.__almond;
        const NX = 192, NY = 224, CELLS = NX * NY;
        const depthBuffers = new Map();
        let totalFrame = 0, targetX = 0, targetY = 0;
        const summary = {
          frames: 0, samples: 0, contactFrames: 0, maxContacts: 0,
          maxPenetration: 0, gapDeficit: 0, maxRenderPenetration: 0,
          renderOverlapSamples: 0, comparedRenderSamples: 0,
          finite: true, limited: false, violations: [], worstPhysics: null, worstRender: null,
        };

        // Independent world-XY rasterizer: neither the physics contact grid nor
        // its candidate list/weights are read. Different layers have a stable
        // order; self-folds inside one continuous tongue deliberately do not.
        const renderContacts = () => {
          const c = a.curtain, geometry = c.surface.geometry;
          const p = geometry.getAttribute('position').array, index = geometry.index.array;
          const height = 2 * (a.camera.position.z - c.o.z0) * Math.tan(a.camera.fov * Math.PI / 360);
          const width = height * a.camera.aspect;
          const x0 = -width * 0.62, y0 = -height * 0.62;
          const sx = NX / (width * 1.24), sy = NY / (height * 1.24);
          const used = new Set(), sourceQuads = new Map();
          const buffer = layer => {
            let b = depthBuffers.get(layer);
            if (!b) {
              b = { min: new Float32Array(CELLS), max: new Float32Array(CELLS), minFace: new Int32Array(CELLS), maxFace: new Int32Array(CELLS) };
              depthBuffers.set(layer, b);
            }
            if (!used.has(layer)) {
              b.min.fill(Infinity); b.max.fill(-Infinity);
              b.minFace.fill(-1); b.maxFace.fill(-1);
              used.add(layer);
            }
            return b;
          };
          for (let tri = 0; tri < index.length / 3; tri++) {
            const face = c.surface.physicsFaceForTriangle(tri), layer = c.faceLayer[face];
            if (face < 0 || layer === undefined) throw new Error(`Render triangle ${tri} has no physical layer`);
            if (!sourceQuads.has(face)) sourceQuads.set(face, c.surface.physicsVerticesForTriangle(tri));
            const b = buffer(layer);
            const ia = index[tri * 3] * 3, ib = index[tri * 3 + 1] * 3, ic = index[tri * 3 + 2] * 3;
            const ax = p[ia], ay = p[ia + 1], bx = p[ib], by = p[ib + 1], cx = p[ic], cy = p[ic + 1];
            const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (Math.abs(det) < 1e-10) continue;
            const ix0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) * sx));
            const ix1 = Math.min(NX - 1, Math.floor((Math.max(ax, bx, cx) - x0) * sx));
            const iy0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) * sy));
            const iy1 = Math.min(NY - 1, Math.floor((Math.max(ay, by, cy) - y0) * sy));
            for (let y = iy0; y <= iy1; y++) for (let x = ix0; x <= ix1; x++) {
              const px = x0 + (x + 0.5) / sx, py = y0 + (y + 0.5) / sy;
              const u = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
              const v = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
              const w = 1 - u - v;
              // Reject only the outer 1% of a triangle, avoiding pixel-centre
              // ambiguity at silhouettes while retaining its actual interior.
              if (Math.min(u, v, w) < 0.01) continue;
              const z = u * p[ia + 2] + v * p[ib + 2] + w * p[ic + 2], at = y * NX + x;
              if (z < b.min[at]) { b.min[at] = z; b.minFace[at] = face; }
              if (z > b.max[at]) { b.max[at] = z; b.maxFace[at] = face; }
            }
          }
          const layers = Array.from(used).sort((x, y) => x - y);
          let maxRenderPenetration = 0, overlaps = 0, compared = 0, ignoredHinges = 0, worst = null;
          for (let front = 1; front < layers.length; front++) for (let back = 0; back < front; back++) {
            const f = depthBuffers.get(layers[front]), b = depthBuffers.get(layers[back]);
            for (let at = 0; at < CELLS; at++) {
              if (f.minFace[at] < 0 || b.maxFace[at] < 0) continue;
              overlaps++;
              const ff = f.minFace[at], bf = b.maxFace[at];
              // Faces sharing an actual (not duplicated) particle are the
              // continuous hinge. They intentionally converge to zero spacing.
              if (sourceQuads.get(ff).some(k => sourceQuads.get(bf).includes(k))) { ignoredHinges++; continue; }
              compared++;
              const penetration = b.max[at] - f.min[at];
              if (penetration > maxRenderPenetration) {
                maxRenderPenetration = penetration;
                worst = {
                  x: x0 + (at % NX + 0.5) / sx, y: y0 + (Math.floor(at / NX) + 0.5) / sy,
                  frontLayer: layers[front], backLayer: layers[back], frontFace: ff, backFace: bf,
                  frontZ: f.min[at], backZ: b.max[at],
                };
              }
            }
          }
          return { maxRenderPenetration, overlaps, compared, ignoredHinges, worst, grid: [NX, NY] };
        };
        const check = (stage, frame, result) => {
          const c = a.curtain;
          const physics = c.collisionStats();
          const render = renderContacts();
          result.samples++;
          if (physics.contacts > 0) result.contactFrames++;
          result.maxContacts = Math.max(result.maxContacts, physics.contacts);
          result.maxPenetration = Math.max(result.maxPenetration, physics.maxPenetration);
          result.gapDeficit = Math.max(result.gapDeficit, physics.gapDeficit);
          result.maxRenderPenetration = Math.max(result.maxRenderPenetration, render.maxRenderPenetration);
          result.renderOverlapSamples += render.overlaps;
          result.comparedRenderSamples += render.compared;
          result.limited ||= physics.limited;
          if (physics.maxPenetration > summary.maxPenetration || physics.gapDeficit > summary.gapDeficit) summary.worstPhysics = { stage, frame, ...physics };
          if (render.maxRenderPenetration > summary.maxRenderPenetration) summary.worstRender = { stage, frame, ...render };
          for (const key of ['maxPenetration', 'gapDeficit', 'maxRenderPenetration']) summary[key] = Math.max(summary[key], result[key]);
          const problems = [];
          if (physics.maxPenetration > thresholds.maxPenetration) problems.push('physical penetration');
          if (physics.gapDeficit > thresholds.gapDeficit) problems.push('thickness deficit');
          if (render.maxRenderPenetration > thresholds.maxRenderPenetration) problems.push('render penetration');
          if (physics.limited) problems.push('contact buffer full');
          if (problems.length) {
            const failure = { stage, frame, problems, physics, render };
            if (result.violations.length < 4) result.violations.push(failure);
            if (summary.violations.length < 24) summary.violations.push(failure);
          }
          result.last = { physics, render };
        };
        window.__contactRegression = {
          reset() { a.release(); a.reset(); a.step(1000 / 60); targetX = targetY = 0; },
          grab(points) {
            for (const point of points) if (a.grab(...point)) { targetX = targetY = 0; return point; }
            return null;
          },
          run({ stage, x = targetX, y = targetY, frames = 60, release = false }) {
            const result = { stage, frames, samples: 0, contactFrames: 0, maxContacts: 0, maxPenetration: 0, gapDeficit: 0, maxRenderPenetration: 0, renderOverlapSamples: 0, comparedRenderSamples: 0, limited: false, finite: true, violations: [] };
            const fromX = targetX, fromY = targetY;
            if (release) a.release();
            for (let i = 1; i <= frames; i++) {
              if (!release) a.pull(fromX + (x - fromX) * i / frames, fromY + (y - fromY) * i / frames);
              a.step(1000 / 60);
              totalFrame++;
              const finite = c => Array.from(c).every(Number.isFinite);
              if (!finite(a.curtain.pos) || !finite(a.curtain.surface.geometry.getAttribute('position').array)) {
                result.finite = summary.finite = false;
                result.violations.push({ stage, frame: totalFrame, problems: ['non-finite cloth position'] });
                break;
              }
              if (i % 4 === 0 || i === frames) check(stage, totalFrame, result);
            }
            targetX = x; targetY = y;
            summary.frames += frames;
            for (const key of ['samples', 'contactFrames', 'renderOverlapSamples', 'comparedRenderSamples']) summary[key] += result[key];
            summary.maxContacts = Math.max(summary.maxContacts, result.maxContacts);
            summary.limited ||= result.limited;
            return { ...result, state: a.state() };
          },
          summary: () => summary,
        };
        window.__contactRegression.reset();
      }, limits);

      const stage = async (label, args) => {
        const result = await page.evaluate(args => window.__contactRegression.run(args), { stage: label, ...args });
        report.stages.push(result);
        const file = `${name}-${String(++stageNumber).padStart(2, '0')}-${label}.png`;
        await page.screenshot({ path: `${out}/${file}` });
        result.screenshot = file;
        writeReport();
        return result;
      };
      const picked = await page.evaluate(() => window.__contactRegression.grab([[0.5, 0.28], [0.48, 0.32]]));
      assert.ok(picked, `${name}: initial grab missed cloth`);
      report.initialGrab = picked;
      await stage('slow-pull', { x: 0, y: -0.1, frames: 72 });
      const deep = await stage('deep-pull', { x: 0, y: -0.7, frames: 96 });
      assert.ok(deep.state.tornEdges > 0, `${name}: no tear generated for contact checks`);
      // Return the torn tongue upward, then sweep it across the main sheet.
      // Low downward displacement avoids detaching it before the overlap pass.
      await stage('fold-up', { x: 0.08, y: 0.14, frames: 96 });
      await stage('fold-left', { x: -0.25, y: -0.18, frames: 72 });
      await stage('fold-right', { x: 0.25, y: -0.2, frames: 72 });
      await stage('fold-up-again', { x: -0.12, y: 0.22, frames: 72 });
      await stage('released', { release: true, frames: 120 });

      const nextGrab = await page.evaluate(() => window.__contactRegression.grab([[0.73, 0.3], [0.27, 0.3], [0.77, 0.48], [0.23, 0.48]]));
      assert.ok(nextGrab, `${name}: could not grab a second visible cloth section`);
      report.secondGrab = nextGrab;
      await stage('second-deep-pull', { x: 0, y: -0.8, frames: 100 });
      const detached = await stage('tear-off-sideways', { x: nextGrab[0] > 0.5 ? -0.65 : 0.65, y: -0.9, frames: 100 });
      assert.ok(detached.state.detachedPieces > 0, `${name}: side pull failed to detach a piece`);
      await stage('scrap-settled', { release: true, frames: 180 });
      await page.waitForTimeout(500);
      report.frameTiming = await page.evaluate(() => new Promise(resolve => {
        const samples = [];
        let previous = 0;
        const tick = now => {
          if (previous) samples.push(now - previous);
          previous = now;
          if (samples.length < 60) requestAnimationFrame(tick);
          else {
            const sorted = [...samples].sort((a, b) => a - b);
            resolve({ meanMs: samples.reduce((a, b) => a + b, 0) / samples.length, p95Ms: sorted[Math.floor(sorted.length * 0.95)], dpr: window.__almond.state().dpr });
          }
        };
        requestAnimationFrame(tick);
      }));
      report.summary = await page.evaluate(() => window.__contactRegression.summary());
      const s = report.summary;
      if (!s.finite) failures.push(`${name}: non-finite positions`);
      if (s.contactFrames === 0 || s.maxContacts === 0) failures.push(`${name}: no physical contact was exercised`);
      if (s.comparedRenderSamples === 0) failures.push(`${name}: no independent cross-layer render samples`);
      for (const key of Object.keys(limits)) if (s[key] > limits[key]) failures.push(`${name}: ${key} ${s[key]} > ${limits[key]}`);
      if (s.limited) failures.push(`${name}: contact buffer overflowed`);
      if (errors.length) failures.push(`${name}: ${errors.length} browser errors`);
      console.log(name, JSON.stringify(report.summary));
    } catch (error) {
      report.failure = String(error);
      failures.push(`${name}: ${String(error)}`);
      await page.screenshot({ path: `${out}/${name}-failure.png` }).catch(() => {});
      report.summary = await page.evaluate(() => window.__contactRegression?.summary()).catch(() => null);
    } finally {
      writeReport();
      await context.close();
    }
  }
  assert.deepEqual(failures, [], 'Contact regression failed; see report.json and stage screenshots');
} finally {
  writeReport();
  await browser.close();
}
