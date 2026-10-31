import * as THREE from 'three';
import { clamp } from './util';

export interface CurtainOpts {
  W: number; // panel width (wider than the view so the side edges never show)
  H: number; // panel height (bottom edge stays off screen)
  top: number; // hem rest height (just above the view)
  z0: number; // hanging plane
  zMin: number; // the panel never goes behind this (the tree lives behind it)
  cols: number;
  rows: number;
}

/**
 * Full-page linen curtain. Verlet particles; the top hem is held by soft clips.
 * Near the hand the clips give way, so a pull carves a V into the hem. Clips
 * then remember part of every dip, which keeps the shape you carved.
 */
export class Curtain {
  readonly o: CurtainOpts;
  readonly cols: number;
  readonly rows: number;
  readonly n: number;
  pos: Float32Array;
  prev: Float32Array;
  inv: Float32Array;
  anc: Float32Array;
  ancBase: Float32Array;
  ancKind: Uint8Array; // 1 hem clip, 2 side
  ca: Uint16Array;
  cb: Uint16Array;
  cr: Float32Array;
  cs: Float32Array;
  nMain = 0; // constraints [0, nMain) every pass; the rest (bending) every other pass
  ret: Float32Array; // remembered hem dip per column
  hemV: Float32Array; // hem vertical velocity per column
  private hemPrev: Float32Array;
  geometry: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  hf: Heightfield;

  iterations = 12;
  grabbing = false;
  grabIdx: number[] = [];
  grabW: number[] = [];
  grabBase: number[] = [];
  grabDX = 0;
  grabDY = 0;
  grabX = 0;
  pullAmt = 0;
  retMax: number;
  retKeep = 0.75;
  nudge = 0;
  dipNow = 0;
  viewW: number;
  time = 0;
  private acc = 0;

  constructor(material: THREE.Material, o: CurtainOpts) {
    this.o = o;
    const { cols, rows } = o;
    this.cols = cols;
    this.rows = rows;
    const n = (this.n = cols * rows);
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.inv = new Float32Array(n).fill(1);
    this.anc = new Float32Array(n * 3);
    this.ancBase = new Float32Array(n * 3);
    this.ancKind = new Uint8Array(n);
    this.ret = new Float32Array(cols);
    this.hemV = new Float32Array(cols);
    this.hemPrev = new Float32Array(cols);
    this.retMax = o.H * 0.32;
    this.viewW = o.W;
    this.hf = new Heightfield(-o.W / 2 - 0.2, o.W / 2 + 0.2, o.top - o.H - 0.2, o.top + 0.3, 72, 64);

    const uvs = new Float32Array(n * 2);
    const comp = 0.9;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const u = i / (cols - 1), v = j / (rows - 1);
        const x = (u - 0.5) * o.W * comp;
        const y = o.top - v * o.H;
        // pleats from the clips, fading down the drop
        const pleat = this.pleat(i) * Math.pow(1 - v, 1.2);
        const z = o.z0 + pleat + Math.sin(u * 9.3 + v * 3.1) * 0.012;
        this.pos.set([x, y, z], k * 3);
        uvs[k * 2] = u;
        uvs[k * 2 + 1] = 1 - v;
        if (j === 0) {
          this.ancKind[k] = 1;
          this.ancBase.set([x, o.top, o.z0 + this.pleat(i)], k * 3);
        } else if (i === 0 || i === cols - 1) {
          this.ancKind[k] = 2;
          this.ancBase.set([x, y, o.z0], k * 3);
        }
      }
    this.anc.set(this.ancBase);
    for (const i of [0, cols - 1]) this.inv[i] = 0;
    this.prev.set(this.pos);

    const A: number[] = [], B: number[] = [], Rl: number[] = [], St: number[] = [];
    const dx = o.W / (cols - 1), dy = o.H / (rows - 1), dd = Math.hypot(dx, dy);
    const add = (a: number, b: number, r: number, s: number) => {
      A.push(a); B.push(b); Rl.push(r); St.push(s);
    };
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (i < cols - 1) add(k, k + 1, dx, 1);
        if (j < rows - 1) add(k, k + cols, dy, 1);
        if (i < cols - 1 && j < rows - 1) {
          add(k, k + cols + 1, dd, 0.7);
          add(k + 1, k + cols, dd, 0.7);
        }
      }
    this.nMain = A.length;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (i < cols - 2) add(k, k + 2, dx * 2, j < 2 ? 0.7 : 0.14);
        if (j === 0 && i < cols - 4) add(k, k + 4, dx * 4, 0.4); // the turned hem is stiffer
        if (j < rows - 2) add(k, k + cols * 2, dy * 2, 0.25);
      }
    this.ca = Uint16Array.from(A);
    this.cb = Uint16Array.from(B);
    this.cr = Float32Array.from(Rl);
    this.cs = Float32Array.from(St);

    const idx: number[] = [];
    for (let j = 0; j < rows - 1; j++)
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i, b = a + cols, c = a + 1, d = b + 1;
        idx.push(a, b, c, b, d, c);
      }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(idx);
    this.geometry.computeVertexNormals();
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    for (let s = 0; s < 160; s++) this.substep(1 / 60);
    this.updateHeightfield();
    this.updateMesh();
  }

  /** irregular gathers along the rod */
  private pleat(i: number) {
    return (Math.sin(i * 1.15) * 0.6 + Math.sin(i * 0.53 + 1.7) * 0.4) * 0.06;
  }

  /** deepest current hem dip, 0..1 of the possible pull */
  openness() {
    let m = 0;
    for (let i = 0; i < this.cols; i++) m = Math.max(m, this.ancBase[i * 3 + 1] - this.pos[i * 3 + 1]);
    return clamp(m / (this.o.H * 0.45), 0, 1.2);
  }

  step(dt: number) {
    this.acc = Math.min(this.acc + dt, 1 / 20);
    const h = 1 / 60;
    const y0 = this.hemPrev;
    while (this.acc >= h) {
      for (let i = 0; i < this.cols; i++) y0[i] = this.pos[i * 3 + 1];
      this.substep(h);
      for (let i = 0; i < this.cols; i++) this.hemV[i] = (this.pos[i * 3 + 1] - y0[i]) / h;
      this.acc -= h;
    }
  }

  private substep(h: number) {
    this.time += h;
    const { pos, prev, inv, n, cols, o } = this;
    const g = -7.5 * h * h;
    const damp = 0.976;
    const t = this.time;

    const pullTarget = this.grabbing ? clamp(-this.grabDY / (o.H * 0.25), 0, 1) : 0;
    this.pullAmt += (pullTarget - this.pullAmt) * (1 - Math.exp(-h / (this.grabbing ? 0.04 : 0.5)));

    for (let k = 0; k < n; k++) {
      if (inv[k] === 0) continue;
      const i3 = k * 3;
      const vx = (pos[i3] - prev[i3]) * damp;
      const vy = (pos[i3 + 1] - prev[i3 + 1]) * damp;
      const vz = (pos[i3 + 2] - prev[i3 + 2]) * damp;
      prev[i3] = pos[i3];
      prev[i3 + 1] = pos[i3 + 1];
      prev[i3 + 2] = pos[i3 + 2];
      const x = pos[i3], y = pos[i3 + 1];
      // a slow breath through the linen
      const wind = (Math.sin(t * 0.6 + x * 0.9 + y * 0.4) * 0.6 + Math.sin(t * 1.7 + x * 2.3) * 0.3) * 0.18 * h * h;
      pos[i3] += vx;
      pos[i3 + 1] += vy + g;
      pos[i3 + 2] += vz + wind;
    }

    // clips slide down with the hand: a V that deepens and widens with the pull
    const sig = this.viewW * (0.12 + 0.2 * this.pullAmt);
    const nudgeSig = this.viewW * 0.08;
    const dip = this.grabbing ? Math.max(0, -this.grabDY) * 0.92 : 0;
    this.dipNow += (dip - this.dipNow) * (1 - Math.exp(-h / 0.05));
    for (let i = 0; i < cols; i++) {
      const k = i * 3;
      const gx = (this.ancBase[k] - this.grabX) / sig;
      const want = Math.max(this.ret[i], this.dipNow * Math.exp(-gx * gx));
      this.anc[k + 1] = this.ancBase[k + 1] - want - this.nudge * 0.38 * Math.exp(-((this.ancBase[k] / nudgeSig) ** 2));
    }

    const { ca, cb, cr, cs, anc, ancKind } = this;
    const nc = ca.length;
    const ITER = this.iterations;
    for (let it = 0; it < ITER; it++) {
      const cEnd = (it & 1) === 0 ? nc : this.nMain;
      for (let c = 0; c < cEnd; c++) {
        const a = ca[c] * 3, b = cb[c] * 3;
        const wa = inv[ca[c]], wb = inv[cb[c]];
        const ws = wa + wb;
        if (ws === 0) continue;
        const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const diff = ((len - cr[c]) / (len * ws)) * cs[c];
        pos[a] += dx * diff * wa;
        pos[a + 1] += dy * diff * wa;
        pos[a + 2] += dz * diff * wa;
        pos[b] -= dx * diff * wb;
        pos[b + 1] -= dy * diff * wb;
        pos[b + 2] -= dz * diff * wb;
      }
      for (let i = 0; i < cols; i++) {
        if (inv[i] === 0) continue;
        const k = i * 3;
        const gx = (this.ancBase[k] - this.grabX) / sig;
        const s = 0.24 * (1 - 0.6 * this.pullAmt * Math.exp(-gx * gx));
        // rings slide along the rod: x is held only lightly, so the hem can gather into a V
        pos[k] += (anc[k] - pos[k]) * s * 0.12;
        pos[k + 1] += (anc[k + 1] - pos[k + 1]) * s;
        pos[k + 2] += (anc[k + 2] - pos[k + 2]) * s;
      }
      for (let k = cols; k < n; k++) {
        if (ancKind[k] !== 2) continue;
        const i3 = k * 3;
        pos[i3] += (anc[i3] - pos[i3]) * 0.2;
        pos[i3 + 2] += (anc[i3 + 2] - pos[i3 + 2]) * 0.2;
      }
      if (this.grabbing) {
        for (let q = 0; q < this.grabIdx.length; q++) {
          const k = this.grabIdx[q] * 3, w = this.grabW[q];
          const tx = this.grabBase[q * 3] + this.grabDX * Math.sqrt(w);
          const ty = this.grabBase[q * 3 + 1] + this.grabDY * Math.sqrt(w);
          pos[k] += (tx - pos[k]) * w * 0.9;
          pos[k + 1] += (ty - pos[k + 1]) * w * 0.9;
        }
      }
      if ((it & 1) === 1 || it === ITER - 1) {
        for (let k = 0; k < n; k++) {
          const i3 = k * 3;
          if (pos[i3 + 2] < o.zMin) {
            pos[i3 + 2] = o.zMin;
            prev[i3 + 2] = o.zMin;
          }
        }
      }
    }
    // the clips remember part of every dip
    if (this.grabbing) {
      for (let i = 0; i < cols; i++) {
        const drop = this.ancBase[i * 3 + 1] - pos[i * 3 + 1];
        const keep = Math.min(this.retMax, drop * this.retKeep);
        if (keep > this.ret[i]) this.ret[i] = keep;
      }
    }
  }

  pick(camera: THREE.Camera, sx: number, sy: number, w: number, h: number, maxPx: number) {
    const v = new THREE.Vector3();
    let best = -1, bd = maxPx * maxPx;
    for (let k = 0; k < this.n; k++) {
      v.fromArray(this.pos, k * 3).project(camera);
      const px = (v.x * 0.5 + 0.5) * w, py = (-v.y * 0.5 + 0.5) * h;
      const d = (px - sx) ** 2 + (py - sy) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  }

  startGrab(k: number) {
    const { cols, rows } = this;
    const gi = k % cols, gj = (k / cols) | 0;
    this.grabIdx = [];
    this.grabW = [];
    this.grabBase = [];
    const sigma = 2.2, R = 5;
    for (let j = Math.max(0, gj - R); j <= Math.min(rows - 1, gj + R); j++)
      for (let i = Math.max(0, gi - R); i <= Math.min(cols - 1, gi + R); i++) {
        const q = j * cols + i;
        if (this.inv[q] === 0) continue;
        const w = Math.exp(-((i - gi) ** 2 + (j - gj) ** 2) / (2 * sigma * sigma));
        if (w < 0.05) continue;
        this.grabIdx.push(q);
        this.grabW.push(w);
        this.grabBase.push(this.pos[q * 3], this.pos[q * 3 + 1], this.pos[q * 3 + 2]);
      }
    this.grabX = this.pos[k * 3];
    this.grabDX = this.grabDY = 0;
    this.grabbing = true;
  }

  setGrab(dx: number, dy: number) {
    this.grabDX = dx;
    this.grabDY = dy;
  }

  release() {
    this.grabbing = false;
  }

  private col(x: number) {
    return clamp((x / (this.o.W * 0.9) + 0.5) * (this.cols - 1), 0, this.cols - 1);
  }

  /** hem height at world x */
  hemY(x: number) {
    const p = this.pos;
    for (let i = 0; i < this.cols - 1; i++) {
      const x0 = p[i * 3], x1 = p[(i + 1) * 3];
      if ((x >= x0 && x <= x1) || (x >= x1 && x <= x0)) {
        const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
        return p[i * 3 + 1] + (p[(i + 1) * 3 + 1] - p[i * 3 + 1]) * t;
      }
    }
    return this.o.top;
  }

  hemVel(x: number) {
    const c = this.col(x), i = Math.floor(c), f = c - i;
    return this.hemV[i] * (1 - f) + this.hemV[Math.min(this.cols - 1, i + 1)] * f;
  }

  /** nearest particle to a world point (local search from the hem column guess) */
  nearest(x: number, y: number, z: number) {
    let best = 0, bd = Infinity;
    const ci = Math.round(this.col(x));
    for (let j = 0; j < this.rows; j++)
      for (let i = Math.max(0, ci - 4); i <= Math.min(this.cols - 1, ci + 4); i++) {
        const k = j * this.cols + i;
        const d = (this.pos[k * 3] - x) ** 2 + (this.pos[k * 3 + 1] - y) ** 2 + (this.pos[k * 3 + 2] - z) ** 2;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
    return best;
  }

  updateHeightfield() {
    const hf = this.hf;
    hf.clear();
    const { cols, rows, pos } = this;
    for (let j = 0; j < rows - 1; j++)
      for (let i = 0; i < cols - 1; i++) {
        const a = (j * cols + i) * 3, b = a + 3, c = a + cols * 3, d = c + 3;
        hf.splatQuad(
          Math.min(pos[a], pos[b], pos[c], pos[d]),
          Math.max(pos[a], pos[b], pos[c], pos[d]),
          Math.min(pos[a + 1], pos[b + 1], pos[c + 1], pos[d + 1]),
          Math.max(pos[a + 1], pos[b + 1], pos[c + 1], pos[d + 1]),
          Math.max(pos[a + 2], pos[b + 2], pos[c + 2], pos[d + 2]),
          // the hem row is the upper boundary: only fill below the actual edge
          j === 0 ? [pos[a], pos[a + 1], pos[b], pos[b + 1]] : null,
        );
      }
  }

  updateMesh() {
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  dispose() {
    this.geometry.dispose();
  }
}

/** coarse front-surface height of the curtain over (x, y); NaN where there is no cloth */
export class Heightfield {
  data: Float32Array;
  constructor(
    readonly x0: number,
    readonly x1: number,
    readonly y0: number,
    readonly y1: number,
    readonly nx: number,
    readonly ny: number,
  ) {
    this.data = new Float32Array(nx * ny);
  }
  clear() {
    this.data.fill(-Infinity);
  }
  splatQuad(minx: number, maxx: number, miny: number, maxy: number, z: number, hem: number[] | null) {
    const sx = this.nx / (this.x1 - this.x0), sy = this.ny / (this.y1 - this.y0);
    const i0 = Math.max(0, Math.floor((minx - this.x0) * sx)), i1 = Math.min(this.nx - 1, Math.floor((maxx - this.x0) * sx));
    const j0 = Math.max(0, Math.floor((miny - this.y0) * sy)), j1 = Math.min(this.ny - 1, Math.floor((maxy - this.y0) * sy));
    for (let j = j0; j <= j1; j++) {
      const cy = this.y0 + (j + 0.5) / sy;
      for (let i = i0; i <= i1; i++) {
        if (hem) {
          const cx = this.x0 + (i + 0.5) / sx;
          const t = hem[2] === hem[0] ? 0 : clamp((cx - hem[0]) / (hem[2] - hem[0]), 0, 1);
          if (cy > hem[1] + (hem[3] - hem[1]) * t) continue;
        }
        const k = j * this.nx + i;
        if (z > this.data[k]) this.data[k] = z;
      }
    }
  }
  sample(x: number, y: number) {
    const i = Math.floor(((x - this.x0) / (this.x1 - this.x0)) * this.nx);
    const j = Math.floor(((y - this.y0) / (this.y1 - this.y0)) * this.ny);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return NaN;
    const v = this.data[j * this.nx + i];
    return v === -Infinity ? NaN : v;
  }
}
