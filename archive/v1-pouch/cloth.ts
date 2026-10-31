import * as THREE from 'three';
import { clamp } from './util';

/**
 * Front panel of a linen pouch pinned to the wall by two nails.
 * Verlet particles + distance constraints; the seams and the gathered top hem
 * are soft anchors, so a hard pull drags the hem down into an opening.
 */
export class Cloth {
  readonly cols: number;
  readonly rows: number;
  readonly W = 1.5;
  readonly H = 1.74;
  readonly top = 0.62;
  readonly comp = 0.88; // seams are narrower than the panel -> slack, folds, bulge
  readonly n: number;
  readonly pinX: number;

  pos: Float32Array;
  prev: Float32Array;
  slow: Float32Array; // low-passed positions, used to measure transient displacement
  inv: Float32Array;
  anc: Float32Array;
  ancBase: Float32Array;
  ancK: Float32Array;
  ancKind: Uint8Array; // 0 none, 1 top hem, 2 side seam, 3 bottom seam
  ca: Uint16Array;
  cb: Uint16Array;
  cr: Float32Array;
  cs: Float32Array;

  geometry: THREE.BufferGeometry;
  mesh: THREE.Mesh;

  grabbing = false;
  grabIdx: number[] = [];
  grabW: number[] = [];
  grabBase: number[] = [];
  grabDX = 0;
  grabDY = 0;
  pullAmt = 0;
  retained = 0;
  retainedTarget = 0;
  restLipY = 0;
  nudge = 0;
  time = 0;
  private acc = 0;
  iterations = 18;
  readonly ell = { cx: 0, cy: -0.52, cz: 0, rx: 0.5, ry: 0.56, rz: 0.15 };
  hf = new Heightfield();
  /** min z the panel must keep where stems are inside the pouch */
  stems = new Heightfield();

  constructor(material: THREE.Material, cols = 30, rows = 36) {
    this.cols = cols;
    this.rows = rows;
    const n = (this.n = cols * rows);
    this.pinX = (this.W * this.comp) / 2;
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.slow = new Float32Array(n * 3);
    this.inv = new Float32Array(n).fill(1);
    this.anc = new Float32Array(n * 3);
    this.ancBase = new Float32Array(n * 3);
    this.ancK = new Float32Array(n);
    this.ancKind = new Uint8Array(n);

    const uvs = new Float32Array(n * 2);
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const u = i / (cols - 1), v = j / (rows - 1);
        const x = (u - 0.5) * this.W * this.comp;
        const y = this.top - v * this.H * 0.965;
        const bulge = 0.13 * Math.pow(Math.sin(Math.PI * u), 0.8) * Math.pow(Math.sin(Math.PI * Math.min(1, v * 1.05)), 0.7);
        const z = 0.02 + bulge + Math.sin(i * 1.7 + j * 0.9) * 0.002;
        this.pos.set([x, y, z], k * 3);
        uvs[k * 2] = u;
        uvs[k * 2 + 1] = 1 - v;
        let kind = 0, K = 0, ax = x, ay = y, az = 0.014;
        if (j === 0) {
          kind = 1;
          K = 0.12;
          ay = this.top - 0.012 * Math.sin(Math.PI * u);
          az = 0.035 + 0.035 * Math.sin(Math.PI * u);
        } else if (i === 0 || i === cols - 1) {
          kind = 2;
          K = 0.3;
        } else if (j === rows - 1) {
          kind = 3;
          K = 0.22;
        }
        this.ancKind[k] = kind;
        this.ancK[k] = K;
        this.ancBase.set([ax, ay, az], k * 3);
        this.anc.set([ax, ay, az], k * 3);
      }
    // nails
    for (const i of [0, cols - 1]) {
      const k = i;
      this.inv[k] = 0;
      this.pos[k * 3 + 1] = this.top;
      this.pos[k * 3 + 2] = 0.03;
    }
    this.prev.set(this.pos);

    // constraints: structural, shear, bend
    const A: number[] = [], B: number[] = [], Rl: number[] = [], St: number[] = [];
    const dx = this.W / (cols - 1), dy = this.H / (rows - 1), dd = Math.hypot(dx, dy);
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
        if (i < cols - 2) add(k, k + 2, dx * 2, 0.18);
        if (j < rows - 2) add(k, k + cols * 2, dy * 2, 0.18);
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

    // settle
    for (let s = 0; s < 200; s++) this.substep(1 / 60);
    this.restLipY = this.lipCenterY();
    this.slow.set(this.pos);
    this.updateMesh();
  }

  lipCenterY() {
    let s = 0, c = 0;
    for (let i = Math.round(this.cols * 0.35); i <= Math.round(this.cols * 0.65); i++) {
      s += this.pos[i * 3 + 1];
      c++;
    }
    return s / c;
  }

  /** 0 closed .. 1 fully open, from how far the hem centre has dropped */
  openness() {
    return clamp((this.restLipY - this.lipCenterY()) / 0.32, 0, 1.2);
  }

  step(dt: number) {
    this.acc = Math.min(this.acc + dt, 1 / 20);
    const h = 1 / 60;
    while (this.acc >= h) {
      this.substep(h);
      this.acc -= h;
    }
    // slow copy of the panel: pos - slow = how much it is being tugged right now
    const k = 1 - Math.exp(-dt / 1.6);
    for (let i = 0; i < this.n * 3; i++) this.slow[i] += (this.pos[i] - this.slow[i]) * k;
  }

  private substep(h: number) {
    this.time += h;
    const { pos, prev, inv, n, cols, rows } = this;
    const g = -7.5 * h * h;
    const damp = Math.pow(0.988, h * 120);
    const t = this.time;
    const wind = (Math.sin(t * 0.7) + Math.sin(t * 1.9 + 1) * 0.5) * 0.25 * h * h;

    // pull: target that the drawstring relaxes towards
    const pullTarget = this.grabbing ? clamp(-this.grabDY / 0.5, 0, 1) : 0;
    this.pullAmt += (pullTarget - this.pullAmt) * (1 - Math.exp(-h / (this.grabbing ? 0.05 : 0.45)));
    this.retained += (this.retainedTarget - this.retained) * (1 - Math.exp(-h / 0.8));

    for (let k = 0; k < n; k++) {
      if (inv[k] === 0) continue;
      const i3 = k * 3;
      const vx = (pos[i3] - prev[i3]) * damp;
      const vy = (pos[i3 + 1] - prev[i3 + 1]) * damp;
      const vz = (pos[i3 + 2] - prev[i3 + 2]) * damp;
      prev[i3] = pos[i3];
      prev[i3 + 1] = pos[i3 + 1];
      prev[i3 + 2] = pos[i3 + 2];
      pos[i3] += vx;
      pos[i3 + 1] += vy + g;
      pos[i3 + 2] += vz + wind * (0.3 + (k % 7) * 0.1);
    }
    // idle hint: a soft tug at the hem
    if (this.nudge > 0.001) {
      const j = rows - 3;
      const i0 = Math.round(cols / 3), i1 = Math.round((cols * 2) / 3);
      for (let i = i0; i < i1; i++) {
        const k = j * cols + i;
        const w = Math.sin(((i - i0) / (i1 - i0 - 1)) * Math.PI);
        pos[k * 3 + 1] -= this.nudge * w * 1.4 * h * h * 60;
      }
    }

    // anchor targets (top hem lowered by what has been pulled out)
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1);
      const prof = Math.pow(Math.sin(Math.PI * u), 1.4);
      this.anc[i * 3 + 1] = this.ancBase[i * 3 + 1] - this.retained * 0.3 * prof;
      this.anc[i * 3 + 2] = this.ancBase[i * 3 + 2] + this.retained * 0.06 * prof;
    }
    const topS = 1 - 0.985 * this.pullAmt;
    const sideS = 1 - 0.3 * this.pullAmt;
    const botS = 1 - 0.9 * this.pullAmt;

    const { ca, cb, cr, cs, anc, ancK, ancKind } = this;
    const nc = ca.length;
    const e = this.ell;
    const ITER = this.iterations;
    for (let it = 0; it < ITER; it++) {
      for (let c = 0; c < nc; c++) {
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
      for (let k = 0; k < n; k++) {
        const kind = ancKind[k];
        if (!kind || inv[k] === 0) continue;
        const s = ancK[k] * (kind === 1 ? topS : kind === 2 ? sideS : botS);
        const i3 = k * 3;
        pos[i3] += (anc[i3] - pos[i3]) * (kind === 3 ? ancK[k] * 0.6 : s);
        // side seams run in a channel: they hold x/z but let the panel slide down
        pos[i3 + 1] += (anc[i3 + 1] - pos[i3 + 1]) * (kind === 2 ? s * (1 - this.pullAmt) * 0.15 : kind === 3 ? s * (1 - 0.92 * this.pullAmt) : s);
        pos[i3 + 2] += (anc[i3 + 2] - pos[i3 + 2]) * s;
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
      // contents bulge + wall (every other pass is enough)
      if ((it & 1) === 0 && it !== ITER - 1) continue;
      for (let k = 0; k < n; k++) {
        const i3 = k * 3;
        const qx = (pos[i3] - e.cx) / e.rx, qy = (pos[i3 + 1] - e.cy) / e.ry, qz = (pos[i3 + 2] - e.cz) / e.rz;
        const d2 = qx * qx + qy * qy + qz * qz;
        if (d2 < 1) {
          const zs = e.cz + e.rz * Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy));
          if (pos[i3 + 2] < zs) pos[i3 + 2] = zs;
        }
        const sz = this.stems.sample(pos[i3], pos[i3 + 1]);
        if (!Number.isNaN(sz) && pos[i3 + 2] < sz && pos[i3 + 1] < this.restLipY + 0.02) pos[i3 + 2] += (sz - pos[i3 + 2]) * 0.5;
        if (pos[i3 + 2] < 0.012) {
          pos[i3 + 2] = 0.012;
          prev[i3] += (pos[i3] - prev[i3]) * 0.3; // wall friction
          prev[i3 + 1] += (pos[i3 + 1] - prev[i3 + 1]) * 0.3;
        }
      }
    }
  }

  /** nearest particle to a screen point (css px), or -1 */
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

  /** inside the projected panel outline? (rough: convex hull of border) */
  startGrab(k: number) {
    const { cols, rows } = this;
    const gi = k % cols, gj = (k / cols) | 0;
    this.grabIdx = [];
    this.grabW = [];
    this.grabBase = [];
    const sc = cols / 30;
    const R = Math.round(6 * sc);
    for (let j = Math.max(0, gj - R); j <= Math.min(rows - 1, gj + R); j++)
      for (let i = Math.max(0, gi - R); i <= Math.min(cols - 1, gi + R); i++) {
        const q = j * cols + i;
        if (this.inv[q] === 0) continue;
        const d2 = (i - gi) ** 2 + (j - gj) ** 2;
        const w = Math.exp(-d2 / (2 * (2.6 * sc) ** 2));
        if (w < 0.05) continue;
        this.grabIdx.push(q);
        this.grabW.push(w);
        this.grabBase.push(this.pos[q * 3], this.pos[q * 3 + 1], this.pos[q * 3 + 2]);
      }
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

  /** y of the hem at world x (or -Infinity if outside the hem span) */
  lipY(x: number) {
    const p = this.pos;
    for (let i = 0; i < this.cols - 1; i++) {
      const x0 = p[i * 3], x1 = p[(i + 1) * 3];
      if ((x >= x0 && x <= x1) || (x >= x1 && x <= x0)) {
        const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
        return p[i * 3 + 1] + (p[(i + 1) * 3 + 1] - p[i * 3 + 1]) * t;
      }
    }
    return -Infinity;
  }

  /** transient displacement of the panel near world (x,y) */
  disp(x: number, y: number, out: THREE.Vector3) {
    const i = clamp(Math.round((x / (this.W * this.comp) + 0.5) * (this.cols - 1)), 0, this.cols - 1);
    const j = clamp(Math.round(((this.top - y) / (this.H * 0.965)) * (this.rows - 1)), 0, this.rows - 1);
    const k = (j * this.cols + i) * 3;
    return out.set(this.pos[k] - this.slow[k], this.pos[k + 1] - this.slow[k + 1], this.pos[k + 2] - this.slow[k + 2]);
  }

  updateHeightfield() {
    const hf = this.hf;
    hf.clear();
    const { cols, rows, pos } = this;
    for (let j = 0; j < rows - 1; j++)
      for (let i = 0; i < cols - 1; i++) {
        const a = (j * cols + i) * 3, b = a + 3, c = a + cols * 3, d = c + 3;
        const minx = Math.min(pos[a], pos[b], pos[c], pos[d]);
        const maxx = Math.max(pos[a], pos[b], pos[c], pos[d]);
        const miny = Math.min(pos[a + 1], pos[b + 1], pos[c + 1], pos[d + 1]);
        const maxy = Math.max(pos[a + 1], pos[b + 1], pos[c + 1], pos[d + 1]);
        const z = Math.max(pos[a + 2], pos[b + 2], pos[c + 2], pos[d + 2]);
        hf.splat(minx, maxx, miny, maxy, z);
      }
  }

  setStems(each: (cb: (x: number, y: number, z: number) => void) => void) {
    const g = this.stems;
    g.clear();
    each((x, y, z) => g.splat(x - 0.035, x + 0.035, y - 0.03, y + 0.03, z));
  }

  updateMesh() {
    const attr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}

/** coarse front-surface height of the panel, for branch collision / exposure tests */
export class Heightfield {
  readonly nx = 56;
  readonly ny = 64;
  readonly x0 = -1.1;
  readonly x1 = 1.1;
  readonly y0 = -1.45;
  readonly y1 = 0.95;
  data = new Float32Array(56 * 64);
  clear() {
    this.data.fill(-Infinity);
  }
  splat(minx: number, maxx: number, miny: number, maxy: number, z: number) {
    const sx = this.nx / (this.x1 - this.x0), sy = this.ny / (this.y1 - this.y0);
    const i0 = Math.max(0, Math.floor((minx - this.x0) * sx)), i1 = Math.min(this.nx - 1, Math.floor((maxx - this.x0) * sx));
    const j0 = Math.max(0, Math.floor((miny - this.y0) * sy)), j1 = Math.min(this.ny - 1, Math.floor((maxy - this.y0) * sy));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * this.nx + i;
        if (z > this.data[k]) this.data[k] = z;
      }
  }
  /** NaN when there is no cloth at (x,y) */
  sample(x: number, y: number) {
    const i = Math.floor(((x - this.x0) / (this.x1 - this.x0)) * this.nx);
    const j = Math.floor(((y - this.y0) / (this.y1 - this.y0)) * this.ny);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return NaN;
    const v = this.data[j * this.nx + i];
    return v === -Infinity ? NaN : v;
  }
}
