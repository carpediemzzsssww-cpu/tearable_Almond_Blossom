import * as THREE from 'three';
import { clamp } from './util';
import { TearTopology } from './tear-topology';

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
  n: number;
  readonly capacity: number;
  readonly baseN: number;
  private topology: TearTopology;
  private active: Uint8Array;
  private detached: Uint8Array;
  private edgeWeight: Float32Array;
  private materialNode: Uint16Array;
  private tornEdges: number[] = [];
  private pieces = 0;
  private rip: { left: number; right: number; top: number; bottom: number; depth: number; detached: boolean; leftPath: number[]; rightPath: number[] } | null = null;
  private tears = 0;
  private tearClock = 0;
  private grabNode = 0;
  private grabMaterial = 0;
  private grabY = 0;
  private smoothDX = 0;
  private smoothDY = 0;
  private tearPulses: { x: number; y: number; at: number; strength: number }[] = [];
  private fringeGeometry: THREE.BufferGeometry;
  private fringeMaterial: THREE.LineBasicMaterial;
  private fringePositions: Float32Array;
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
    this.baseN = n;
    this.capacity = n + 768;
    this.topology = new TearTopology(cols, rows);
    this.active = new Uint8Array(this.capacity);
    this.active.fill(1, 0, n);
    this.detached = new Uint8Array(this.capacity);
    this.edgeWeight = new Float32Array(this.capacity);
    this.materialNode = new Uint16Array(this.capacity);
    for (let k = 0; k < n; k++) this.materialNode[k] = k;
    this.pos = new Float32Array(this.capacity * 3);
    this.prev = new Float32Array(this.capacity * 3);
    this.inv = new Float32Array(this.capacity).fill(1);
    this.anc = new Float32Array(this.capacity * 3);
    this.ancBase = new Float32Array(this.capacity * 3);
    this.ancKind = new Uint8Array(this.capacity);
    this.ret = new Float32Array(cols);
    this.hemV = new Float32Array(cols);
    this.hemPrev = new Float32Array(cols);
    this.retMax = o.H * 0.32;
    this.viewW = o.W;
    this.hf = new Heightfield(-o.W / 2 - 0.2, o.W / 2 + 0.2, o.top - o.H - 0.2, o.top + 0.3, 72, 64);

    const uvs = new Float32Array(this.capacity * 2);
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

    // One small dynamic line buffer gives each cut individual warp/weft ends.
    this.fringePositions = new Float32Array(24000);
    this.fringeGeometry = new THREE.BufferGeometry();
    this.fringeGeometry.setAttribute('position', new THREE.BufferAttribute(this.fringePositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.fringeGeometry.setDrawRange(0, 0);
    this.fringeMaterial = new THREE.LineBasicMaterial({ color: '#d8c5a6', transparent: true, opacity: 0.58 });
    const fringe = new THREE.LineSegments(this.fringeGeometry, this.fringeMaterial);
    fringe.frustumCulled = false;
    this.mesh.add(fringe);

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
    if (this.topology.cuts) {
      for (let i = 0; i < this.cols; i++) {
        const x = (i / (this.cols - 1) - 0.5) * this.viewW;
        m = Math.max(m, this.o.top - this.hemY(x));
      }
    } else {
      for (let i = 0; i < this.cols; i++) m = Math.max(m, this.ancBase[i * 3 + 1] - this.pos[i * 3 + 1]);
    }
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
    const follow = 1 - Math.exp(-h / 0.024);
    this.smoothDX += (this.grabDX - this.smoothDX) * follow;
    this.smoothDY += (this.grabDY - this.smoothDY) * follow;
    this.advanceTear(h);

    const holdingCurtain = this.grabbing && !this.detached[this.grabNode];
    const pullTarget = holdingCurtain ? clamp(-this.grabDY / (o.H * 0.25), 0, 1) : 0;
    this.pullAmt += (pullTarget - this.pullAmt) * (1 - Math.exp(-h / (this.grabbing ? 0.04 : 0.5)));

    for (let k = 0; k < n; k++) {
      if (inv[k] === 0 || !this.active[k]) continue;
      const i3 = k * 3;
      const vx = clamp((pos[i3] - prev[i3]) * damp, -0.12, 0.12);
      const vy = clamp((pos[i3 + 1] - prev[i3 + 1]) * damp, -0.12, 0.12);
      const vz = clamp((pos[i3 + 2] - prev[i3 + 2]) * damp, -0.08, 0.08);
      prev[i3] = pos[i3];
      prev[i3 + 1] = pos[i3 + 1];
      prev[i3 + 2] = pos[i3 + 2];
      const x = pos[i3], y = pos[i3 + 1];
      // a slow breath through the linen
      const wind = (Math.sin(t * 0.6 + x * 0.9 + y * 0.4) * 0.6 + Math.sin(t * 1.7 + x * 2.3) * 0.3) * 0.18 * h * h;
      pos[i3] += vx;
      pos[i3 + 1] += vy + g;
      pos[i3 + 2] += vz + wind * (1 + this.edgeWeight[k] * 5);
      // Frayed borders catch a little air; freed fragments fall under gravity.
      if (this.edgeWeight[k]) pos[i3 + 2] += (o.z0 + 0.045 - pos[i3 + 2]) * h * 0.6;
    }

    // clips slide down with the hand: a V that deepens and widens with the pull
    const sig = this.viewW * (0.12 + 0.2 * this.pullAmt);
    const nudgeSig = this.viewW * 0.08;
    const dip = holdingCurtain ? Math.max(0, -this.grabDY) * 0.92 : 0;
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
        if (inv[i] === 0 || ancKind[i] !== 1) continue;
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
          const tx = this.grabBase[q * 3] + this.smoothDX * Math.sqrt(w);
          const ty = this.grabBase[q * 3 + 1] + this.smoothDY * Math.sqrt(w);
          pos[k] += (tx - pos[k]) * w * 0.9;
          pos[k + 1] += (ty - pos[k + 1]) * w * 0.65;
          const lift = Math.min(0.17, Math.hypot(this.smoothDX, this.smoothDY) * 0.16);
          pos[k + 2] += (this.grabBase[q * 3 + 2] + lift * w - pos[k + 2]) * w * 0.14;
        }
      }
      if ((it & 1) === 1 || it === ITER - 1) {
        for (let k = 0; k < n; k++) {
          const i3 = k * 3;
          if (pos[i3 + 2] < o.zMin) {
            pos[i3 + 2] = o.zMin;
            prev[i3 + 2] = o.zMin;
          }
          if (pos[i3 + 2] > o.z0 + 0.7) {
            pos[i3 + 2] = o.z0 + 0.7;
            prev[i3 + 2] = pos[i3 + 2];
          }
        }
      }
    }
    // Retire whole fallen pieces only once every vertex is outside the bottom.
    if (this.pieces) {
      const visible = new Set<number>();
      for (let k = 0; k < this.n; k++) if (this.detached[k] && this.active[k] && pos[k * 3 + 1] > o.top - o.H - 0.25) visible.add(this.detached[k]);
      let retired = false;
      for (let k = 0; k < this.n; k++) {
        if (!this.detached[k] || !this.active[k] || visible.has(this.detached[k])) continue;
        this.active[k] = 0; this.inv[k] = 0; retired = true;
      }
      if (retired) this.rebuildTears();
    }
    // Detached scraps no longer pull or leave a memory in the main curtain.
    if (holdingCurtain) {
      for (let i = 0; i < cols; i++) {
        const drop = this.ancBase[i * 3 + 1] - pos[i * 3 + 1];
        const keep = Math.min(this.retMax, drop * this.retKeep);
        if (keep > this.ret[i]) this.ret[i] = keep;
      }
    }
  }

  isParticleActive(k: number) {
    return k >= 0 && k < this.n && this.active[k] === 1;
  }

  tearEnergyAt(x: number, y: number) {
    let energy = 0;
    const radius = this.o.H * 0.17;
    for (const p of this.tearPulses) {
      const age = this.time - p.at;
      if (age > 1.5) continue;
      energy = Math.max(energy, p.strength * Math.exp(-age / 0.38 - ((x - p.x) ** 2 + (y - p.y) ** 2) / (radius * radius)));
    }
    return Math.min(1, energy);
  }

  stats() {
    let active = 0;
    for (let k = 0; k < this.n; k++) active += this.active[k];
    return { tornEdges: this.topology.cuts, detachedPieces: this.pieces, clothParticles: active, tearEnergy: this.tearEnergyAt(this.grabX, this.grabY) };
  }

  private advanceTear(h: number) {
    // Material fatigue depends on extension, not the browser's event frequency.
    this.tearClock += h;
    const down = Math.max(0, -this.smoothDY), threshold = this.o.H * 0.18;
    if (!this.grabbing || down < threshold || this.tearClock < 0.045 || this.tears >= 6 && !this.rip) return;
    this.tearClock = 0;
    const gi = this.grabMaterial % this.cols, gj = Math.floor(this.grabMaterial / this.cols);
    if (gi < 4 || gi > this.cols - 5 || gj > this.rows - 6 || this.detached[this.grabNode]) return;
    let changed = false;
    if (!this.rip) {
      const width = Math.max(2, Math.round(this.cols * 0.065));
      const bottom = Math.min(this.rows - 3, gj + 4);
      const leftPath: number[] = [], rightPath: number[] = [];
      for (let row = 0; row <= bottom; row++) {
        // Follow a warp yarn. Curvature comes from the cloth, irregularity from loose fibres.
        leftPath.push(gi - width);
        rightPath.push(gi + width);
      }
      this.rip = { left: gi - width, right: gi + width, top: 0, bottom, depth: 0, detached: false, leftPath, rightPath };
      this.tears++;
    }
    const r = this.rip;
    const want = Math.min(r.bottom, 2 + Math.floor((down - threshold) / this.o.H * 55));
    if (r.depth < want) {
      const row = r.depth;
      for (const path of [r.leftPath, r.rightPath]) {
        const column = path[row];
        if (row > 0) {
          const before = path[row - 1];
          for (let x = Math.min(column, before); x < Math.max(column, before); x++) changed = this.topology.cutH(x, row) || changed;
        }
        changed = this.topology.cutV(column, row) || changed;
      }
      r.depth++;
    } else if (!r.detached && r.depth >= Math.max(3, gj + 1) && Math.abs(this.smoothDX) > this.viewW * 0.15 && down > this.o.H * 0.24) {
      // A sideways tug releases the lower hinge of the hanging tongue.
      for (let x = r.leftPath[r.depth - 1]; x < r.rightPath[r.depth - 1]; x++) changed = this.topology.cutH(x, r.depth) || changed;
      r.detached = true;
    }
    if (!changed) return;
    this.tearPulses.push({ x: this.pos[this.grabNode * 3], y: this.pos[this.grabNode * 3 + 1], at: this.time, strength: 0.7 });
    if (this.tearPulses.length > 24) this.tearPulses.shift();
    this.rebuildTears();
    this.refreshTornGrip();
  }

  private rebuildTears() {
    const uv = this.geometry.getAttribute('uv') as THREE.BufferAttribute;
    this.topology.split(source => {
      if (this.n >= this.capacity) throw new Error('Cloth tear capacity exhausted');
      const k = this.n++;
      for (let axis = 0; axis < 3; axis++) {
        this.pos[k * 3 + axis] = this.pos[source * 3 + axis];
        this.prev[k * 3 + axis] = this.prev[source * 3 + axis];
        this.anc[k * 3 + axis] = this.anc[source * 3 + axis];
        this.ancBase[k * 3 + axis] = this.ancBase[source * 3 + axis];
      }
      this.active[k] = this.active[source];
      this.inv[k] = this.inv[source];
      this.ancKind[k] = this.ancKind[source];
      this.detached[k] = this.detached[source];
      this.materialNode[k] = this.materialNode[source];
      uv.setXY(k, uv.getX(source), uv.getY(source));
      return k;
    });
    uv.needsUpdate = true;
    this.tornEdges = this.topology.edges();
    this.edgeWeight.fill(0);
    for (const k of this.tornEdges) {
      this.edgeWeight[k] = 1;
      // The two newly loosened lips roll toward the viewer, instead of lying perfectly flat.
      this.prev[k * 3 + 2] -= 0.0015;
    }
    if (this.rip && this.rip.depth > 0) {
      // The peeled strip is free at the rod; its neighbours retain their original clips.
      for (let x = this.rip.leftPath[0]; x < this.rip.rightPath[0]; x++) {
        const f = x * 4;
        this.ancKind[this.topology.faces[f]] = 0;
        this.ancKind[this.topology.faces[f + 1]] = 0;
      }
    }
    const A: number[] = [], B: number[] = [], lengths: number[] = [], strengths: number[] = [];
    const seen = new Set<number>();
    const add = (a: number, b: number, strength: number) => {
      if (!this.active[a] || !this.active[b] || a === b) return;
      const key = Math.min(a, b) * this.capacity + Math.max(a, b);
      if (seen.has(key)) return;
      seen.add(key);
      const ma = this.materialNode[a], mb = this.materialNode[b];
      const dx = (ma % this.cols - mb % this.cols) * this.o.W / (this.cols - 1);
      const dy = (Math.floor(ma / this.cols) - Math.floor(mb / this.cols)) * this.o.H / (this.rows - 1);
      A.push(a); B.push(b); lengths.push(Math.hypot(dx, dy)); strengths.push(strength);
    };
    const faces = this.topology.faces, indices: number[] = [];
    for (let f = 0; f < faces.length; f += 4) {
      const a = faces[f], b = faces[f + 1], c = faces[f + 2], d = faces[f + 3];
      if (!this.active[a]) continue;
      indices.push(a, c, b, c, d, b);
      add(a, b, 1); add(a, c, 1); add(b, d, 1); add(c, d, 1);
      add(a, d, 0.7); add(b, c, 0.7);
    }
    this.nMain = A.length;
    for (let y = 0; y < this.rows - 1; y++) for (let x = 0; x < this.cols - 1; x++) {
      const f = (y * (this.cols - 1) + x) * 4;
      if (x < this.cols - 2 && !this.topology.vertical[y * this.cols + x + 1]) {
        add(faces[f], faces[f + 5], y === 0 ? 0.5 : 0.14);
        add(faces[f + 2], faces[f + 7], 0.14);
      }
      if (y < this.rows - 2 && !this.topology.horizontal[(y + 1) * (this.cols - 1) + x]) {
        const next = f + (this.cols - 1) * 4;
        add(faces[f], faces[next + 2], 0.25); add(faces[f + 1], faces[next + 3], 0.25);
      }
    }
    this.ca = Uint16Array.from(A); this.cb = Uint16Array.from(B);
    this.cr = Float32Array.from(lengths); this.cs = Float32Array.from(strengths);
    this.geometry.setIndex(indices);
    // Connectivity determines whether a piece can really fall; no hand-authored disappearing faces.
    const roots = Int32Array.from({ length: this.n }, (_, i) => i);
    const find = (i: number): number => {
      while (roots[i] !== i) { roots[i] = roots[roots[i]]; i = roots[i]; }
      return i;
    };
    for (let c = 0; c < this.nMain; c++) roots[find(B[c])] = find(A[c]);
    const anchored = new Set<number>(), oldPiece = new Map<number, number>();
    for (let k = 0; k < this.n; k++) {
      if (this.ancKind[k] || this.inv[k] === 0) anchored.add(find(k));
      if (this.detached[k]) oldPiece.set(find(k), this.detached[k]);
    }
    const groups = new Map<number, number>();
    for (let k = 0; k < this.n; k++) {
      if (!this.active[k]) continue;
      const root = find(k);
      if (!anchored.has(root)) {
        if (!groups.has(root)) groups.set(root, oldPiece.get(root) || ++this.pieces);
        this.detached[k] = groups.get(root)!;
      }
    }
  }

  private refreshTornGrip() {
    const r = this.rip;
    if (!r) return;
    const old = new Map<number, [number, number, number]>();
    for (let q = 0; q < this.grabIdx.length; q++) old.set(this.materialNode[this.grabIdx[q]], [this.grabBase[q * 3], this.grabBase[q * 3 + 1], this.grabBase[q * 3 + 2]]);
    const picked = new Set<number>();
    for (let y = r.top; y < Math.max(r.depth, Math.min(r.bottom, Math.floor(this.grabMaterial / this.cols) + 2)); y++) for (let x = r.leftPath[y]; x < r.rightPath[y]; x++) {
      const f = (y * (this.cols - 1) + x) * 4;
      for (let c = 0; c < 4; c++) picked.add(this.topology.faces[f + c]);
    }
    this.grabIdx = []; this.grabW = []; this.grabBase = [];
    const gi = this.grabMaterial % this.cols, gj = Math.floor(this.grabMaterial / this.cols);
    for (const k of picked) {
      const m = this.materialNode[k], dx = m % this.cols - gi, dy = Math.floor(m / this.cols) - gj;
      const w = Math.exp(-(dx * dx + dy * dy) / 4.2);
      if (w < 0.05) continue;
      const base = old.get(m) || [this.pos[k * 3] - this.smoothDX * Math.sqrt(w), this.pos[k * 3 + 1] - this.smoothDY * Math.sqrt(w), this.pos[k * 3 + 2]];
      this.grabIdx.push(k); this.grabW.push(w); this.grabBase.push(...base);
      if (m === this.grabMaterial) this.grabNode = k;
    }
  }

  private updateFringe() {
    let at = 0;
    const p = this.pos, out = this.fringePositions;
    for (let e = 0; e < this.tornEdges.length; e += 2) {
      const a = this.tornEdges[e], b = this.tornEdges[e + 1];
      if (!this.active[a]) continue;
      const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
      const dx = p[b * 3] - ax, dy = p[b * 3 + 1] - ay, dz = p[b * 3 + 2] - az;
      const len = Math.hypot(dx, dy) || 1;
      const side = (e & 2) ? -1 : 1;
      for (let j = 0; j < 4 && at + 12 <= out.length; j++) {
        if (Math.sin(e * 11.17 + j * 5.43) > 0.7) continue;
        const t = (j + 0.5 + 0.44 * Math.sin(e * 2.3 + j * 4)) / 4;
        const x = ax + dx * t, y = ay + dy * t, z = az + dz * t + 0.002;
        const l = 0.003 + 0.021 * (0.5 + 0.5 * Math.sin(e * 8.12 + j * 1.71)) ** 2;
        const skew = Math.sin(e * 2.9 + j * 8) * 0.9;
        const nx = (-dy * side + dx * skew) / len * l, ny = (dx * side + dy * skew) / len * l;
        const curl = Math.sin(this.time * 1.7 + e + j) * 0.002;
        out.set([x, y, z, x + nx * 0.65, y + ny * 0.65, z + l * 0.35, x + nx * 0.65, y + ny * 0.65, z + l * 0.35, x + nx, y + ny - l * 0.18, z + l * 0.2 + curl], at);
        at += 12;
      }
    }
    this.fringeGeometry.setDrawRange(0, at / 3);
    (this.fringeGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  pick(camera: THREE.Camera, sx: number, sy: number, w: number, h: number, maxPx: number) {
    const v = new THREE.Vector3();
    let best = -1, bd = maxPx * maxPx;
    for (let k = 0; k < this.n; k++) {
      if (!this.active[k]) continue;
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
    const { cols } = this;
    const material = this.materialNode[k];
    const gi = material % cols, gj = (material / cols) | 0;
    this.grabNode = k;
    this.grabMaterial = material;
    this.grabY = this.pos[k * 3 + 1];
    this.rip = null;
    this.smoothDX = this.smoothDY = 0;
    this.grabIdx = [];
    this.grabW = [];
    this.grabBase = [];
    const sigma = 1.45, R = 4;
    // Grow the grip through connected faces, so a finger never holds both lips of a tear.
    const reach = new Set<number>([k]);
    for (let pass = 0; pass < R; pass++) {
      const add: number[] = [];
      for (let f = 0; f < this.topology.faces.length; f += 4) {
        const face = this.topology.faces;
        if (![face[f], face[f + 1], face[f + 2], face[f + 3]].some(q => reach.has(q))) continue;
        for (let c = 0; c < 4; c++) {
          const q = face[f + c], m = this.materialNode[q];
          if (Math.abs(m % cols - gi) <= R && Math.abs(Math.floor(m / cols) - gj) <= R) add.push(q);
        }
      }
      for (const q of add) reach.add(q);
    }
    for (const q of reach) {
      if (this.inv[q] === 0 || !this.active[q]) continue;
      const m = this.materialNode[q], i = m % cols, j = Math.floor(m / cols);
      const w = Math.exp(-((i - gi) ** 2 + (j - gj) ** 2) / (2 * sigma * sigma));
      if (w < 0.05) continue;
      this.grabIdx.push(q); this.grabW.push(w);
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


  /** Upper envelope of the actual attached boundary, including the new torn lips. */
  private boundaryAt(x: number, velocity: boolean) {
    const p = this.pos;
    let highest = -Infinity, speed = 0;
    const count = (this.cols - 1) + this.tornEdges.length / 2;
    for (let edge = 0; edge < count; edge++) {
      const top = edge < this.cols - 1;
      const e = (edge - (this.cols - 1)) * 2;
      const a = top ? this.topology.faces[edge * 4] : this.tornEdges[e];
      const b = top ? this.topology.faces[edge * 4 + 1] : this.tornEdges[e + 1];
      if (!this.active[a] || !this.active[b] || this.detached[a] || this.detached[b]) continue;
      const x0 = p[a * 3], x1 = p[b * 3];
      if (x < Math.min(x0, x1) || x > Math.max(x0, x1) || Math.abs(x1 - x0) < 1e-7) continue;
      const t = (x - x0) / (x1 - x0);
      const y = p[a * 3 + 1] * (1 - t) + p[b * 3 + 1] * t;
      if (y <= highest) continue;
      highest = y;
      speed = ((p[a * 3 + 1] - this.prev[a * 3 + 1]) * (1 - t) + (p[b * 3 + 1] - this.prev[b * 3 + 1]) * t) * 60;
    }
    return velocity ? clamp(speed, -3, 3) : highest === -Infinity ? this.o.top : highest;
  }

  hemY(x: number) {
    return this.boundaryAt(x, false);
  }

  hemVel(x: number) {
    return this.boundaryAt(x, true);
  }

  /** nearest particle to a world point (local search from the hem column guess) */
  nearest(x: number, y: number, z: number) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < this.n; k++) {
      if (!this.active[k]) continue;
      const d = (this.pos[k * 3] - x) ** 2 + (this.pos[k * 3 + 1] - y) ** 2 + (this.pos[k * 3 + 2] - z) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  updateHeightfield() {
    const hf = this.hf;
    hf.clear();
    const p = this.pos, faces = this.topology.faces;
    for (let f = 0; f < faces.length; f += 4) {
      const a = faces[f], b = faces[f + 1], c = faces[f + 2], d = faces[f + 3];
      if (!this.active[a]) continue;
      hf.splatTriangle(p, a, c, b);
      hf.splatTriangle(p, c, d, b);
    }
  }

  updateMesh() {
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.updateFringe();
  }

  dispose() {
    this.geometry.dispose();
    this.fringeGeometry.dispose();
    this.fringeMaterial.dispose();
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
  splatTriangle(p: Float32Array, a: number, b: number, c: number) {
    const ax = p[a * 3], ay = p[a * 3 + 1], bx = p[b * 3], by = p[b * 3 + 1], cx = p[c * 3], cy = p[c * 3 + 1];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-10) return;
    const sx = this.nx / (this.x1 - this.x0), sy = this.ny / (this.y1 - this.y0);
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - this.x0) * sx));
    const i1 = Math.min(this.nx - 1, Math.floor((Math.max(ax, bx, cx) - this.x0) * sx));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - this.y0) * sy));
    const j1 = Math.min(this.ny - 1, Math.floor((Math.max(ay, by, cy) - this.y0) * sy));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = this.x0 + (i + 0.5) / sx, y = this.y0 + (j + 0.5) / sy;
      const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
      const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
      if (u < -0.001 || v < -0.001 || u + v > 1.001) continue;
      const z = u * p[a * 3 + 2] + v * p[b * 3 + 2] + (1 - u - v) * p[c * 3 + 2];
      const k = j * this.nx + i;
      if (z > this.data[k]) this.data[k] = z;
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
