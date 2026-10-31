import * as THREE from 'three';
import { mulberry32, clamp, lerp, smoothstep, ease } from './util';
import { petalGeometry, centerGeometry, budGeometry, leafGeometry } from './geometry';

export interface BlossomContext {
  time: number;
  maxOpen: number; // furthest the mouth has been opened (branches stay out)
  openVel: number; // d(open)/dt
  wave: number; // 0..1, recent fast-pull energy
  pullVX: number;
  lipY: (x: number) => number;
  clothZ: (x: number, y: number) => number; // NaN where there is no cloth
  disp: (x: number, y: number, out: THREE.Vector3) => THREE.Vector3;
}

type Kind = 'rise' | 'reach' | 'spill' | 'twig';

interface Mode {
  start: number;
  k: number;
  c: number;
  a: number;
  av: number;
  p: number;
  pv: number;
}

interface Branch {
  main: boolean;
  kind: Kind;
  parent: number;
  attach: number;
  attachFrac: number;
  n: number; // nodes
  seg: Float32Array; // n-1
  rad: Float32Array; // n
  openA: Float32Array;
  openP: Float32Array;
  foldA: Float32Array;
  foldP: Float32Array;
  nIn: number; // first node outside the pouch (mains)
  base: THREE.Vector3;
  thr: number;
  u: number;
  uv: number;
  len0: number;
  e: number;
  side: number;
  phase: number;
  modes: Mode[];
  acc: number; // summed angular acceleration (drives children)
  front: boolean; // allowed to hang in front of the cloth
  pos: Float32Array;
  curA: Float32Array;
  curP: Float32Array;
  out: Uint8Array;
  col0: THREE.Color;
  col1: THREE.Color;
}

const enum BT {
  Flower,
  Bud,
  Leaf,
}

interface Bloom {
  type: BT;
  br: number;
  node: number;
  ot: number;
  on: number;
  ob: number;
  at: number;
  an: number;
  ab: number;
  bias: number;
  size: number;
  spin: number;
  tilt: number;
  b: number;
  vis: number;
  rate: number;
  ph: number;
  petal0: number;
  tint: THREE.Color;
  slot: number;
  x: number;
  y: number;
  z: number;
}

interface Petal {
  variant: number;
  slot: number;
  phi: number;
  tilt: number;
  twist: number;
  w: number;
  l: number;
}

interface Fallen {
  on: boolean;
  p: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  w: THREE.Vector3;
  life: number;
  s: number;
  ph: number;
}

const Zw = new THREE.Vector3(0, 0, 1);
const Yw = new THREE.Vector3(0, 1, 0);
const VARIANTS = [
  { w: 0.5, cup: 0.18, curl: 0.06, ruffle: 0.04, skew: 0.0 },
  { w: 0.46, cup: 0.26, curl: 0.12, ruffle: 0.06, skew: 0.04 },
  { w: 0.54, cup: 0.12, curl: -0.03, ruffle: 0.03, skew: -0.05 },
];

export class Blossoms {
  group = new THREE.Group();
  branches: Branch[] = [];
  blooms: Bloom[] = [];
  petals: Petal[] = [];
  fallen: Fallen[] = [];

  private segMesh!: THREE.InstancedMesh;
  private jointMesh!: THREE.InstancedMesh;
  private petalMeshes: THREE.InstancedMesh[] = [];
  private centerMesh!: THREE.InstancedMesh;
  private budMesh!: THREE.InstancedMesh;
  private leafMesh!: THREE.InstancedMesh;
  private fallMesh!: THREE.InstancedMesh;

  // scratch
  private m1 = new THREE.Matrix4();
  private m2 = new THREE.Matrix4();
  private mF = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private T = new THREE.Vector3();
  private N = new THREE.Vector3();
  private B = new THREE.Vector3();
  private S = new THREE.Vector3();
  private d = new THREE.Vector3();
  private fallCooldown = 0;
  private idleFall = 6;

  constructor(petalTex: THREE.Texture, seed = 20261031) {
    const R = mulberry32(seed);
    this.generate(R);
    this.buildMeshes(petalTex, R);
  }

  // ───────────────────────────── generation ─────────────────────────────

  private generate(R: () => number) {
    const kinds: Kind[] = ['reach', 'rise', 'spill', 'rise', 'reach', 'rise', 'rise', 'reach', 'rise', 'spill', 'reach', 'rise'];
    const M = kinds.length;
    for (let b = 0; b < M; b++) {
      const kind = kinds[b];
      const xs = lerp(-0.36, 0.36, b / (M - 1)) + (R() - 0.5) * 0.05;
      const side = Math.abs(xs) < 0.04 ? (R() < 0.5 ? -1 : 1) : Math.sign(xs);
      const xb = xs, yb = -0.8 + R() * 0.12, zb = 0.05 + R() * 0.025;
      const xm = xs * 0.8 + (R() - 0.5) * 0.08, ym = 0.46 + R() * 0.1;
      const dist = Math.hypot(xm - xb, ym - yb);
      const nIn = Math.max(6, Math.round(dist / 0.09));
      const aIn = Math.atan2(xm - xb, ym - yb);
      let A: number, Lout: number, droop: number, P: number;
      if (kind === 'rise') {
        A = side * (0.06 + R() * 0.42);
        Lout = 0.5 + R() * 0.38;
        droop = 0.25 + R() * 0.35;
        P = 0.12 + R() * 0.22;
      } else if (kind === 'reach') {
        A = side * (0.95 + R() * 0.35);
        Lout = 0.95 + R() * 0.4;
        droop = 0.9 + R() * 0.5;
        P = 0.06 + R() * 0.18;
      } else {
        A = side * (0.12 + R() * 0.15);
        Lout = 0.78 + R() * 0.2;
        droop = 0;
        P = 1.3 + R() * 0.12;
      }
      const segOut = 0.04;
      const nOut = Math.round(Lout / segOut);
      const nSeg = nIn + nOut;
      const br = this.newBranch(true, kind, nSeg + 1);
      br.base.set(xb, yb, zb);
      br.nIn = nIn;
      br.side = side;
      br.front = kind === 'spill';
      const absX = Math.abs(xs);
      br.thr = kind === 'rise' ? absX * 0.5 + R() * 0.05 : kind === 'reach' ? 0.18 + R() * 0.2 : 0.26 + R() * 0.14;
      br.thr = Math.min(br.thr, 0.55);
      for (let j = 0; j < nIn; j++) {
        br.seg[j] = dist / nIn;
        br.openA[j] = aIn + Math.sin(j * 0.8 + xb * 9) * 0.09 + (R() - 0.5) * 0.06;
        br.openP[j] = (R() - 0.5) * 0.04;
        br.foldA[j] = aIn + ((j >> 1) & 1 ? 0.45 : -0.45);
        br.foldP[j] = 0;
      }
      let kink = (R() - 0.5) * 0.3, run = 0;
      for (let k = 0; k < nOut; k++) {
        const f = k / Math.max(1, nOut - 1);
        if (--run <= 0) {
          kink = -Math.sign(kink || 1) * (0.1 + R() * 0.24);
          run = 2 + ((R() * 3) | 0);
        }
        const turn = smoothstep(0, 0.28, f);
        const j = nIn + k;
        if (kind === 'spill') {
          // lean toward the viewer first, swing round while pointing at us, then hang
          // down over the front of the hem
          br.openP[j] = P * smoothstep(0, 0.28, f) * (1 - 0.82 * smoothstep(0.36, 0.8, f));
          br.openA[j] = lerp(aIn, A, smoothstep(0, 0.25, f)) + side * (Math.PI - 0.3 - Math.abs(A)) * smoothstep(0.24, 0.42, f) + kink * 0.6;
        } else {
          br.openA[j] = lerp(aIn, A, turn) + side * droop * Math.pow(f, 1.6) + kink;
          br.openP[j] = P * smoothstep(0, 0.35, f) * (1 - 0.3 * f);
        }
        br.foldA[j] = aIn + ((k >> 1) & 1 ? 1 : -1) * (0.7 + R() * 0.3);
        br.foldP[j] = 0.02;
        br.seg[j] = segOut * (0.85 + R() * 0.3);
      }
      let L = 0;
      for (let j = 0; j < nSeg; j++) L += br.seg[j];
      const r0 = 0.0125 + R() * 0.004 + (kind === 'reach' ? 0.002 : 0);
      let s = 0;
      for (let j = 0; j <= nSeg; j++) {
        br.rad[j] = r0 * (1 - 0.78 * Math.pow(s / L, 0.75));
        if (j < nSeg) s += br.seg[j];
      }
      const fq = [0.75, 1.3, 2.1];
      for (let m = 0; m < 3; m++) {
        const f = fq[m] * (0.85 + R() * 0.3);
        const k = (2 * Math.PI * f) ** 2;
        const z = 0.09 + R() * 0.04;
        br.modes.push({ start: nIn + Math.round(nOut * [0, 0.35, 0.65][m]), k, c: 2 * z * Math.sqrt(k), a: 0, av: 0, p: 0, pv: 0 });
      }
      br.col0.set('#3a2e27');
      br.col1.set('#6e5240');
      const bi = this.branches.length;
      this.branches.push(br);
      this.fitFolded(br, kind === 'rise' && absX < 0.2 ? 0.44 : 0.3);
      this.addBlooms(bi, R, nIn + 1, br.n - 1, 0.22, 0.1);
      this.addTwigs(bi, R);
    }
  }

  private newBranch(main: boolean, kind: Kind, n: number): Branch {
    return {
      main, kind, parent: -1, attach: 0, attachFrac: 0, n,
      seg: new Float32Array(n - 1), rad: new Float32Array(n),
      openA: new Float32Array(n - 1), openP: new Float32Array(n - 1),
      foldA: new Float32Array(n - 1), foldP: new Float32Array(n - 1),
      nIn: 0, base: new THREE.Vector3(), thr: 0, u: 0, uv: 0, len0: 0.5, e: 0,
      side: 1, phase: Math.random() * 10, modes: [], acc: 0, front: false,
      pos: new Float32Array(n * 3), curA: new Float32Array(n - 1), curP: new Float32Array(n - 1), out: new Uint8Array(n),
      col0: new THREE.Color(), col1: new THREE.Color(),
    };
  }

  /** shrink the folded (u=0) length so the crumpled branch hides below the hem */
  private fitFolded(br: Branch, maxY: number) {
    let y = br.base.y, top = y;
    for (let j = 0; j < br.n - 1; j++) {
      y += Math.cos(br.foldA[j]) * br.seg[j] * 0.5;
      top = Math.max(top, y);
    }
    br.len0 = top > maxY ? 0.5 * (maxY - br.base.y) / (top - br.base.y) : 0.5;
  }

  private addTwigs(pi: number, R: () => number) {
    const p = this.branches[pi];
    const nOut = p.n - 1 - p.nIn;
    let k = 1 + ((R() * 2) | 0);
    let s = R() < 0.5 ? 1 : -1;
    while (k < nOut - 2) {
      const len = Math.max(2, Math.round((3 + R() * 5) * (1 - 0.45 * (k / nOut))));
      const tw = this.newBranch(false, 'twig', len + 1);
      tw.parent = pi;
      tw.attach = p.nIn + k;
      tw.attachFrac = k / nOut;
      tw.side = s;
      tw.front = p.front;
      const aRel = s * (0.45 + R() * 0.55), pRel = (R() - 0.3) * 0.6;
      let kink = 0;
      for (let m = 0; m < len; m++) {
        if (m % 2 === 0) kink = (R() - 0.5) * 0.4;
        tw.openA[m] = aRel + s * 0.15 * m * R() + kink;
        tw.openP[m] = pRel * (0.6 + 0.4 * (m / len));
        tw.foldA[m] = aRel * 0.15;
        tw.foldP[m] = 0;
        tw.seg[m] = 0.032 * (0.85 + R() * 0.3);
      }
      const r0 = p.rad[tw.attach] * 0.6;
      for (let m = 0; m <= len; m++) tw.rad[m] = lerp(r0, 0.0025, m / len);
      const f = 2.2 + R() * 1.2, kk = (2 * Math.PI * f) ** 2;
      tw.modes.push({ start: 0, k: kk, c: 2 * 0.1 * Math.sqrt(kk), a: 0, av: 0, p: 0, pv: 0 });
      tw.col0.set('#5a4334');
      tw.col1.set(R() < 0.5 ? '#7c6a3e' : '#80523f');
      const ti = this.branches.length;
      this.branches.push(tw);
      this.addBlooms(ti, R, 1, len, 0.34, 0.14);
      s = -s;
      k += 3 + ((R() * 3) | 0);
    }
  }

  private addBlooms(bi: number, R: () => number, from: number, to: number, pFlower: number, pBud: number) {
    for (let node = from; node <= to; node++) {
      const tip = node === to;
      const r = R();
      if (tip) {
        if (r < 0.5) this.addBloom(bi, node, BT.Flower, R);
        else this.addBloom(bi, node, BT.Bud, R);
        if (R() < 0.45) this.addBloom(bi, node, BT.Bud, R);
        if (R() < 0.4) this.addBloom(bi, node, BT.Leaf, R);
        continue;
      }
      if (r < pFlower) {
        this.addBloom(bi, node, BT.Flower, R);
        if (R() < 0.08) this.addBloom(bi, node, BT.Flower, R);
      } else if (r < pFlower + pBud) this.addBloom(bi, node, BT.Bud, R);
      if (R() < 0.07) this.addBloom(bi, node, BT.Leaf, R);
    }
  }

  private addBloom(bi: number, node: number, type: BT, R: () => number) {
    const br = this.branches[bi];
    const psi = Math.PI / 2 + (R() - 0.5) * Math.PI * 1.5; // favour the side facing us
    const roff = br.rad[node] + (type === BT.Leaf ? 0.002 : 0.006);
    const tint = new THREE.Color(1, 1, 1);
    const tr = R();
    if (tr < 0.18) tint.setRGB(1, 0.9, 0.91);
    else if (tr < 0.5) tint.setRGB(1, 0.965, 0.955);
    else if (tr < 0.62) tint.setRGB(0.96, 0.985, 0.99);
    const bl: Bloom = {
      type, br: bi, node,
      ot: (R() - 0.5) * 0.01, on: Math.cos(psi) * roff, ob: Math.sin(psi) * roff,
      at: type === BT.Bud ? 0.9 : 0.1 + R() * 0.5, an: Math.cos(psi), ab: Math.sin(psi),
      bias: type === BT.Flower ? 0.2 + R() * 0.6 : 0.2,
      size: type === BT.Flower ? 0.044 + R() * 0.018 : type === BT.Bud ? 0.046 + R() * 0.016 : 0.065 + R() * 0.035,
      spin: R() * Math.PI * 2,
      tilt: 0.12 + R() * 0.38,
      b: 0, vis: 0, rate: 1 / (0.6 + R() * 1.1), ph: R() * 10,
      petal0: -1, tint, slot: 0, x: 0, y: 0, z: 0,
    };
    if (type === BT.Leaf) {
      bl.an = br.side * (R() < 0.5 ? 1 : -1);
      bl.tilt = 0.5 + R() * 0.5;
    }
    if (type === BT.Flower) {
      bl.petal0 = this.petals.length;
      for (let k = 0; k < 5; k++)
        this.petals.push({
          variant: (R() * VARIANTS.length) | 0, slot: 0,
          phi: (k / 5) * Math.PI * 2 + (R() - 0.5) * 0.24,
          tilt: (R() - 0.5) * 0.24, twist: (R() - 0.5) * 0.3,
          w: 0.88 + R() * 0.24, l: 0.88 + R() * 0.2,
        });
    }
    this.blooms.push(bl);
  }

  // ───────────────────────────── meshes ─────────────────────────────

  private buildMeshes(petalTex: THREE.Texture, R: () => number) {
    let nSeg = 0, nJoint = 0;
    for (const b of this.branches) {
      nSeg += b.n - 1;
      nJoint += b.n;
    }
    const bark = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88 });
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 7, 1, true).translate(0, 0.5, 0);
    this.segMesh = new THREE.InstancedMesh(cyl, bark, nSeg);
    this.jointMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 7, 5), bark, nJoint);
    const c = new THREE.Color();
    let si = 0, ji = 0;
    for (const b of this.branches) {
      for (let j = 0; j < b.n; j++) {
        const f = Math.pow(j / (b.n - 1), 1.4);
        c.copy(b.col0).lerp(b.col1, f).multiplyScalar(0.9 + R() * 0.2);
        if (j < b.n - 1) this.segMesh.setColorAt(si++, c);
        this.jointMesh.setColorAt(ji++, c);
      }
    }
    for (const m of [this.segMesh, this.jointMesh]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }

    const petalMat = new THREE.MeshStandardMaterial({
      map: petalTex, roughness: 0.6, side: THREE.DoubleSide,
      emissive: new THREE.Color('#fff1ea'), emissiveMap: petalTex, emissiveIntensity: 0.14,
    });
    // a little light bleeding through thin petals
    petalMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        reflectedLight.directDiffuse += diffuseColor.rgb * 0.12 * (1.0 - abs(dot(normal, vec3(0.0,0.0,1.0))));`,
      );
    };
    const counts = VARIANTS.map(() => 0);
    for (const p of this.petals) p.slot = counts[p.variant]++;
    this.petalMeshes = VARIANTS.map((v, i) => {
      const m = new THREE.InstancedMesh(petalGeometry(v), petalMat, Math.max(1, counts[i]));
      m.count = counts[i];
      return m;
    });
    for (const bl of this.blooms) {
      if (bl.type !== BT.Flower) continue;
      for (let k = 0; k < 5; k++) {
        const p = this.petals[bl.petal0 + k];
        this.petalMeshes[p.variant].setColorAt(p.slot, bl.tint);
      }
    }
    const flowers = this.blooms.filter((b) => b.type === BT.Flower);
    const buds = this.blooms.filter((b) => b.type === BT.Bud);
    const leaves = this.blooms.filter((b) => b.type === BT.Leaf);
    flowers.forEach((b, i) => (b.slot = i));
    buds.forEach((b, i) => (b.slot = i));
    leaves.forEach((b, i) => (b.slot = i));
    const vc = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide });
    this.centerMesh = new THREE.InstancedMesh(centerGeometry(R), vc, Math.max(1, flowers.length));
    this.budMesh = new THREE.InstancedMesh(budGeometry(), vc, Math.max(1, buds.length));
    this.leafMesh = new THREE.InstancedMesh(leafGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }), Math.max(1, leaves.length));
    this.centerMesh.castShadow = false;
    for (const m of [...this.petalMeshes, this.budMesh, this.leafMesh]) m.castShadow = true;
    for (const m of [...this.petalMeshes, this.centerMesh, this.budMesh, this.leafMesh]) {
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }

    const FALL = 12;
    this.fallMesh = new THREE.InstancedMesh(petalGeometry(VARIANTS[0]), petalMat, FALL);
    this.fallMesh.castShadow = true;
    this.fallMesh.frustumCulled = false;
    for (let i = 0; i < FALL; i++) {
      this.fallen.push({ on: false, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), life: 0, s: 0, ph: i * 1.7 });
      this.fallMesh.setMatrixAt(i, this.m1.makeScale(0, 0, 0));
    }
    this.group.add(this.segMesh, this.jointMesh, ...this.petalMeshes, this.centerMesh, this.budMesh, this.leafMesh, this.fallMesh);
  }

  // ───────────────────────────── simulation ─────────────────────────────

  /** call cb(x, y, minZ) for every stem node still inside the pouch */
  forInside(cb: (x: number, y: number, z: number) => void) {
    for (const br of this.branches) {
      if (!br.main) continue;
      for (let j = 1; j < br.n; j++) {
        if (br.out[j]) break;
        cb(br.pos[j * 3], br.pos[j * 3 + 1], br.pos[j * 3 + 2] + br.rad[j] + 0.022);
      }
    }
  }

  stats() {
    const out = this.blooms.filter((b) => b.type === BT.Flower && b.b > 0.5).length;
    return { branches: this.branches.length, flowers: this.blooms.filter((b) => b.type === BT.Flower).length, bloomed: out };
  }

  update(dt: number, ctx: BlossomContext) {
    const t = ctx.time;
    const zeta = lerp(1.0, 0.36, ctx.wave);
    const disp = this.v3;

    for (let bi = 0; bi < this.branches.length; bi++) {
      const br = this.branches[bi];
      let baseA = 0, baseP = 0, lenScale: number;
      let bx: number, by: number, bz: number;
      const parent = br.main ? null : this.branches[br.parent];

      if (br.main) {
        const target = smoothstep(br.thr, br.thr + 0.38, ctx.maxOpen);
        const k = 34, c = 2 * zeta * Math.sqrt(k);
        br.uv += (k * (target - br.u) - c * br.uv) * dt;
        br.u = clamp(br.u + br.uv * dt, 0, 1.2);
        lenScale = lerp(br.len0, 1, br.u);
        ctx.disp(br.base.x, br.base.y, disp);
        bx = br.base.x + clamp(disp.x, -0.1, 0.1) * 0.4;
        by = br.base.y + clamp(disp.y, -0.2, 0.1) * 0.45;
        bz = br.base.z + clamp(disp.z, -0.05, 0.05) * 0.3;
      } else {
        const pu = parent!.u;
        const st = br.attachFrac * 0.55;
        br.e = smoothstep(st, st + 0.45, pu) * (pu > 1 ? pu : 1);
        lenScale = lerp(0.25, 1, Math.min(br.e, 1.15));
        const ai = br.attach;
        bx = parent!.pos[ai * 3];
        by = parent!.pos[ai * 3 + 1];
        bz = parent!.pos[ai * 3 + 2];
        baseA = parent!.curA[Math.min(ai, parent!.n - 2)];
        baseP = parent!.curP[Math.min(ai, parent!.n - 2)];
      }

      // sway
      const wake = br.main ? smoothstep(0.05, 0.4, br.u) : br.e;
      br.acc = 0;
      for (let mi = 0; mi < br.modes.length; mi++) {
        const m = br.modes[mi];
        const w = br.main ? 0.6 + mi * 0.45 : 1;
        const wind = (Math.sin(t * 0.9 + br.phase + mi) * 0.6 + Math.sin(t * 2.13 + br.phase * 1.7) * 0.3 + Math.sin(t * 0.37 + br.phase * 0.5) * 0.5) * 0.03 * w * (1 + ctx.wave * 1.5);
        let Fa = m.k * (wind * wake - m.a) - m.c * m.av;
        let Fp = m.k * (wind * 0.5 * wake - m.p) - m.c * m.pv;
        if (br.main) {
          Fa += (ctx.openVel * 1.2 * br.side - br.uv * 1.3 * br.side + ctx.pullVX * 1.2) * w * m.k * 0.016;
          Fp += (-ctx.openVel * 0.9 + br.uv * 0.5) * w * m.k * 0.016;
        } else {
          Fa += -parent!.acc * 0.45;
          Fp += -parent!.acc * 0.15 * br.side;
        }
        m.av += Fa * dt;
        m.a = clamp(m.a + m.av * dt, -0.9, 0.9);
        m.pv += Fp * dt;
        m.p = clamp(m.p + m.pv * dt, -0.7, 0.7);
        br.acc += Fa;
      }

      // integrate shape
      const pos = br.pos;
      pos[0] = bx;
      pos[1] = by;
      pos[2] = bz;
      let x = bx, y = by, z = bz;
      const nS = br.n - 1;
      const uu = br.main ? br.u : br.e;
      const over = Math.max(0, uu - 1);
      let crossed = br.main ? false : parent!.out[br.attach] === 1;
      br.out[0] = crossed ? 1 : 0;
      for (let j = 0; j < nS; j++) {
        const f = j / Math.max(1, nS - 1);
        const raw = br.main ? uu * 1.3 - 0.3 * f : uu * 1.2 - 0.2 * f;
        const e = Math.min(ease(clamp(raw, 0, 1)) + over, 1.18);
        let a = baseA + br.foldA[j] + (br.openA[j] - br.foldA[j]) * e;
        let p = baseP + br.foldP[j] + (br.openP[j] - br.foldP[j]) * e;
        if (br.main) {
          for (const m of br.modes)
            if (j >= m.start) {
              a += m.a;
              p += m.p;
            }
        } else {
          const r = (j + 1) / nS;
          a += br.modes[0].a * r;
          p += br.modes[0].p * r;
        }
        br.curA[j] = a;
        br.curP[j] = p;
        const cp = Math.cos(p);
        const L = br.seg[j] * lenScale;
        x += Math.sin(a) * cp * L;
        y += Math.cos(a) * cp * L;
        z += Math.sin(p) * L;
        // a node is "out" once the path has climbed over the hem; before that it
        // stays behind the cloth, after that it may only hang in front of it
        const r = br.rad[j + 1];
        const ly = ctx.lipY(x);
        const hz = ctx.clothZ(x, y);
        // cleared the cloth: nothing of the panel at this (x, y) any more
        if (!crossed && Number.isNaN(hz) && y > ly - 0.05 && (br.main ? e > 0.02 : true)) crossed = true;
        if (!crossed) {
          if (!Number.isNaN(hz) && z > hz - 0.018 - r) z = hz - 0.018 - r;
          if (z < 0.012 + r) z = 0.012 + r;
        } else {
          if (!Number.isNaN(hz)) {
            const minz = hz + 0.012 + r;
            if (z < minz) z = minz;
          }
          if (z < 0.01 + r) z = 0.01 + r;
        }
        br.out[j + 1] = crossed ? 1 : 0;
        pos[(j + 1) * 3] = x;
        pos[(j + 1) * 3 + 1] = y;
        pos[(j + 1) * 3 + 2] = z;
      }
    }

    this.writeBranches();
    this.writeBlooms(dt, ctx);
    this.updateFallen(dt, ctx);
  }

  private frame(br: Branch, node: number) {
    const j = Math.min(node, br.n - 2);
    const a = br.curA[j], p = br.curP[j], cp = Math.cos(p);
    this.T.set(Math.sin(a) * cp, Math.cos(a) * cp, Math.sin(p));
    this.N.set(-this.T.y, this.T.x, 0);
    if (this.N.lengthSq() < 1e-6) this.N.set(1, 0, 0);
    this.N.normalize();
    this.B.crossVectors(this.T, this.N);
  }

  private writeBranches() {
    let si = 0, ji = 0;
    const { m1, q, v1, v2, S } = this;
    for (const br of this.branches) {
      const p = br.pos;
      for (let j = 0; j < br.n; j++) {
        v1.fromArray(p, j * 3);
        const r = br.rad[j];
        m1.compose(v1, q.identity(), S.set(r, r, r));
        this.jointMesh.setMatrixAt(ji++, m1);
        if (j < br.n - 1) {
          v2.fromArray(p, (j + 1) * 3).sub(v1);
          const len = v2.length();
          if (len > 1e-6) v2.divideScalar(len);
          else v2.set(0, 1, 0);
          q.setFromUnitVectors(Yw, v2);
          const rr = (r + br.rad[j + 1]) * 0.5;
          m1.compose(v1, q, S.set(rr, len, rr));
          this.segMesh.setMatrixAt(si++, m1);
        }
      }
    }
    this.segMesh.instanceMatrix.needsUpdate = true;
    this.jointMesh.instanceMatrix.needsUpdate = true;
  }

  private writeBlooms(dt: number, ctx: BlossomContext) {
    const { m1, m2, mF, q, q2, v1, v2, T, N, B, S, d } = this;
    const t = ctx.time;
    for (const bl of this.blooms) {
      const br = this.branches[bl.br];
      this.frame(br, bl.node);
      v1.fromArray(br.pos, bl.node * 3);
      v1.addScaledVector(T, bl.ot).addScaledVector(N, bl.on).addScaledVector(B, bl.ob);
      bl.x = v1.x;
      bl.y = v1.y;
      bl.z = v1.z;
      const hz = ctx.clothZ(v1.x, v1.y);
      const exposed = br.out[bl.node] === 1 && (Number.isNaN(hz) || v1.z > hz + 0.002 || v1.y > ctx.lipY(v1.x) + 0.01);
      const rate = bl.rate * (1 + ctx.wave * 1.6);
      if (exposed) bl.b = Math.min(1, bl.b + dt * rate);
      else if (bl.b < 0.5) bl.b = Math.max(0, bl.b - dt * 0.4);
      bl.vis = exposed ? Math.min(1, bl.vis + dt * 5) : bl.b < 0.5 ? Math.max(0, bl.vis - dt * 5) : bl.vis;
      const o = ease(bl.b);
      const vis = ease(bl.vis);

      if (bl.type === BT.Leaf) {
        // blade direction: off the twig, a bit toward us
        d.copy(T).multiplyScalar(Math.cos(bl.tilt)).addScaledVector(N, Math.sin(bl.tilt) * bl.an).addScaledVector(B, 0.35).normalize();
        v2.copy(B).addScaledVector(d, -B.dot(d)).normalize(); // face normal
        const X = this.v3.crossVectors(d, v2);
        m1.makeBasis(X, d, v2);
        const sw = Math.sin(t * 2.4 + bl.ph) * 0.06 * (1 + ctx.wave * 3);
        m2.makeRotationY(sw);
        m1.multiply(m2);
        const s = bl.size * (0.25 + 0.75 * o) * vis;
        m1.scale(S.set(s, s, s));
        m1.setPosition(v1);
        this.leafMesh.setMatrixAt(bl.slot, m1);
        continue;
      }

      // axis
      d.set(0, 0, 0).addScaledVector(T, bl.at).addScaledVector(N, bl.an).addScaledVector(B, bl.ab).normalize();
      d.x += 0;
      d.y += bl.bias * 0.18;
      d.z += bl.bias;
      d.normalize();
      q.setFromUnitVectors(Zw, d);
      const flutter = ctx.wave * 0.25 * Math.sin(t * 7 + bl.ph);
      q2.setFromAxisAngle(Zw, bl.spin + flutter * 0.5);
      q.multiply(q2);

      if (bl.type === BT.Bud) {
        const s = bl.size * (0.55 + 0.45 * o) * vis;
        mF.compose(v1, q, S.set(s, s, s));
        this.budMesh.setMatrixAt(bl.slot, mF);
        continue;
      }

      const s = bl.size * (0.42 + 0.58 * o) * vis;
      mF.compose(v1, q, S.set(s, s, s));
      this.m1.copy(mF).scale(S.set(0.55 + 0.45 * o, 0.55 + 0.45 * o, 0.55 + 0.45 * o));
      this.centerMesh.setMatrixAt(bl.slot, this.m1);
      const breath = Math.sin(t * 1.3 + bl.ph) * 0.02;
      for (let k = 0; k < 5; k++) {
        const p = this.petals[bl.petal0 + k];
        const tilt = lerp(1.38, bl.tilt, o) + p.tilt * o + breath + flutter * (0.6 + 0.4 * Math.sin(k * 2.1));
        m1.makeRotationZ(p.phi);
        m2.makeTranslation(0, 0.06, 0);
        m1.multiply(m2);
        m2.makeRotationX(tilt);
        m1.multiply(m2);
        m2.makeRotationY(p.twist * o);
        m1.multiply(m2);
        m2.makeScale(p.w, p.l, 1);
        m1.multiply(m2);
        m2.multiplyMatrices(mF, m1);
        this.petalMeshes[p.variant].setMatrixAt(p.slot, m2);
      }
    }
    for (const m of [...this.petalMeshes, this.centerMesh, this.budMesh, this.leafMesh]) m.instanceMatrix.needsUpdate = true;
  }

  /** a few petals let go on a fast pull; never a shower */
  private updateFallen(dt: number, ctx: BlossomContext) {
    this.fallCooldown -= dt;
    const open = this.blooms.filter((b) => b.type === BT.Flower && b.b > 0.85);
    if (ctx.wave > 0.6 && this.fallCooldown <= 0 && open.length > 6) {
      this.spawn(open, 2 + ((Math.random() * 3) | 0));
      this.fallCooldown = 1.6;
    }
    this.idleFall -= dt;
    if (this.idleFall <= 0) {
      if (open.length > 20) this.spawn(open, 1);
      this.idleFall = 9 + Math.random() * 8;
    }
    const { m1, S } = this;
    const t = ctx.time;
    for (let i = 0; i < this.fallen.length; i++) {
      const f = this.fallen[i];
      if (!f.on) continue;
      f.life += dt;
      f.v.y -= 0.55 * dt;
      f.v.multiplyScalar(Math.exp(-2.4 * dt));
      f.v.x += Math.sin(t * 2.3 + f.ph) * 0.35 * dt;
      f.v.z += Math.cos(t * 1.7 + f.ph) * 0.12 * dt;
      f.p.addScaledVector(f.v, dt);
      if (f.p.z < 0.02) {
        f.p.z = 0.02;
        f.v.z = Math.abs(f.v.z) * 0.3;
      }
      this.q2.setFromAxisAngle(this.v2.copy(f.w).normalize(), f.w.length() * dt * (0.6 + 0.4 * Math.sin(t * 3 + f.ph)));
      f.q.multiply(this.q2);
      const fade = clamp((9 - f.life) / 1.2, 0, 1) * clamp((f.p.y + 2.6) / 0.4, 0, 1);
      if (fade <= 0) {
        f.on = false;
        this.fallMesh.setMatrixAt(i, m1.makeScale(0, 0, 0));
        continue;
      }
      const s = f.s * fade;
      m1.compose(f.p, f.q, S.set(s, s, s));
      this.fallMesh.setMatrixAt(i, m1);
    }
    this.fallMesh.instanceMatrix.needsUpdate = true;
  }

  private spawn(open: Bloom[], n: number) {
    for (let k = 0; k < n; k++) {
      const f = this.fallen.find((x) => !x.on);
      if (!f) return;
      const b = open[(Math.random() * open.length) | 0];
      f.on = true;
      f.life = 0;
      f.s = b.size * 0.95;
      f.p.set(b.x + (Math.random() - 0.5) * 0.04, b.y + (Math.random() - 0.5) * 0.04, b.z + 0.02);
      f.v.set(Math.sign(b.x || 1) * (0.08 + Math.random() * 0.18), 0.05 + Math.random() * 0.15, 0.05 + Math.random() * 0.1);
      f.q.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
      f.w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 3);
    }
  }
}
