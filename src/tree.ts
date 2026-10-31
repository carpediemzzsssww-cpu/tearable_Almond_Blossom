import * as THREE from 'three';
import { mulberry32, clamp, lerp } from './util';
import { petalGeometry, centerGeometry, budGeometry, leafGeometry } from './geometry';
import type { Curtain } from './curtain';

export interface TreeCtx {
  time: number;
  wave: number; // 0..1 recent fast-pull energy
  curtain: Curtain;
  /** visible to the camera, i.e. not hidden behind the curtain (with parallax) */
  exposed: (x: number, y: number, z: number) => boolean;
}

interface Mode {
  start: number;
  k: number;
  c: number;
  a: number;
  av: number;
  p: number;
  pv: number;
}

interface Br {
  depth: 0 | 1 | 2;
  parent: number;
  attach: number;
  n: number;
  seg: Float32Array;
  rad: Float32Array;
  restA: Float32Array; // limb: absolute; others: relative to the parent heading at attach
  restP: Float32Array;
  pressA: number; // while the cloth presses it: dragged a little toward "down"
  pendant: boolean;
  base: THREE.Vector3;
  r: number; // release spring: 0 pressed flat behind the linen, 1 free
  rv: number;
  rk: number;
  rc: number;
  modes: Mode[];
  acc: number;
  phase: number;
  side: number;
  pos: Float32Array;
  curA: Float32Array;
  curP: Float32Array;
  out: Uint8Array;
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
  delay: number;
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
  landed: number; // curtain particle index, -1 while in the air
  off: THREE.Vector3;
  p: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  w: THREE.Vector3;
  life: number;
  s: number;
  ph: number;
  born: number;
}

const Zw = new THREE.Vector3(0, 0, 1);
const Yw = new THREE.Vector3(0, 1, 0);
const VARIANTS = [
  { w: 0.5, cup: 0.18, curl: 0.06, ruffle: 0.04, skew: 0.0 },
  { w: 0.46, cup: 0.26, curl: 0.12, ruffle: 0.06, skew: 0.04 },
  { w: 0.54, cup: 0.12, curl: -0.03, ruffle: 0.03, skew: -0.05 },
];
const easeOutBack = (x: number) => {
  const c = 1.4;
  const t = x - 1;
  return 1 + (c + 1) * t * t * t + c * t * t;
};

/**
 * An almond tree in the style of Van Gogh's "Almond Blossom": gnarled limbs
 * crossing the frame, twigs and blossoms. It lives behind the curtain; whatever
 * the curtain uncovers springs forward and blooms.
 */
export class Tree {
  group = new THREE.Group();
  /** meshes that cast the soft silhouette onto the backlit linen */
  silhouette: THREE.Object3D[] = [];
  branches: Br[] = [];
  blooms: Bloom[] = [];
  petals: Petal[] = [];
  fallen: Fallen[] = [];
  readonly L: number;

  private segMesh!: THREE.InstancedMesh;
  private jointMesh!: THREE.InstancedMesh;
  private petalMeshes: THREE.InstancedMesh[] = [];
  private centerMesh!: THREE.InstancedMesh;
  private budMesh!: THREE.InstancedMesh;
  private leafMesh!: THREE.InstancedMesh;
  private fallMesh!: THREE.InstancedMesh;
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
  private idleFall = 5;
  private fallSerial = 0;
  private sideFlip = 1;

  constructor(view: { W: number; H: number }, petalTex: THREE.Texture, seed = 1890) {
    this.L = Math.min(view.W, view.H);
    const R = mulberry32(seed);
    this.generate(view, R);
    this.buildMeshes(petalTex, R);
  }

  // ───────────────────────── generation ─────────────────────────

  private generate(view: { W: number; H: number }, R: () => number) {
    const { W, H } = view;
    const portrait = W < H;
    // limbs in view-normalised coords (x: -0.5..0.5 of width, y: of height)
    const limbs: { from: [number, number]; to: [number, number]; z: number; r: number }[] = portrait
      ? [
          { from: [-0.62, -0.02], to: [0.3, 0.42], z: 0.12, r: 0.017 },
          { from: [0.62, 0.2], to: [-0.25, 0.36], z: 0.15, r: 0.014 },
          { from: [-0.05, -0.62], to: [0.12, 0.12], z: 0.1, r: 0.019 },
          { from: [0.5, 0.58], to: [0.05, 0.16], z: 0.18, r: 0.011 },
          { from: [-0.62, 0.3], to: [-0.1, 0.46], z: 0.16, r: 0.011 },
        ]
      : [
          { from: [-0.56, -0.18], to: [0.16, 0.42], z: 0.12, r: 0.017 },
          { from: [0.56, 0.06], to: [-0.08, 0.38], z: 0.15, r: 0.015 },
          { from: [-0.1, -0.62], to: [0.04, 0.1], z: 0.1, r: 0.019 },
          { from: [0.36, 0.6], to: [0.1, 0.1], z: 0.18, r: 0.012 },
          { from: [-0.56, 0.36], to: [-0.2, 0.3], z: 0.16, r: 0.011 },
          { from: [0.56, -0.3], to: [0.3, 0.02], z: 0.13, r: 0.012 },
        ];
    for (const lb of limbs) {
      const x0 = lb.from[0] * W, y0 = lb.from[1] * H, x1 = lb.to[0] * W, y1 = lb.to[1] * H;
      const dist = Math.hypot(x1 - x0, y1 - y0);
      const nSeg = Math.max(4, Math.round(dist / (0.05 * this.L)));
      const br = this.newBr(0, nSeg + 1);
      br.base.set(x0, y0, lb.z);
      br.r = 1;
      const a0 = Math.atan2(x1 - x0, y1 - y0);
      const sd = R() * 10;
      let kink = 0, run = 0;
      for (let j = 0; j < nSeg; j++) {
        const f = j / nSeg;
        if (--run <= 0) {
          kink = -Math.sign(kink || 1) * (0.06 + R() * 0.18);
          run = 2 + ((R() * 3) | 0);
        }
        br.restA[j] = a0 + Math.sin(f * 5.3 + sd) * 0.2 + Math.sin(f * 11.1 + sd * 2) * 0.07 + kink;
        br.restP[j] = (R() - 0.5) * 0.06;
        br.seg[j] = (dist / nSeg) * (0.9 + R() * 0.2);
      }
      const r0 = lb.r * this.L;
      for (let j = 0; j <= nSeg; j++) br.rad[j] = r0 * (1 - 0.55 * Math.pow(j / nSeg, 0.8));
      br.modes.push(this.mode(0, 0.45 + R() * 0.2, 0.18));
      const li = this.branches.length;
      this.branches.push(br);
      this.addBlooms(li, R, 3, nSeg, 0.07, 0.04, false);
      let j = 1 + ((R() * 2) | 0);
      while (j < nSeg - 1) {
        this.addChild(li, j, 1, R, br.restA[j]);
        j += 2 + ((R() * 2) | 0);
      }
    }
  }

  private mode(start: number, f: number, zeta: number): Mode {
    const k = (2 * Math.PI * f) ** 2;
    return { start, k, c: 2 * zeta * Math.sqrt(k), a: 0, av: 0, p: 0, pv: 0 };
  }

  private newBr(depth: 0 | 1 | 2, n: number): Br {
    return {
      depth, parent: -1, attach: 0, n,
      seg: new Float32Array(n - 1), rad: new Float32Array(n),
      restA: new Float32Array(n - 1), restP: new Float32Array(n - 1),
      pressA: 0, pendant: false, base: new THREE.Vector3(),
      r: 0, rv: 0, rk: 60, rc: 6, modes: [], acc: 0, phase: Math.random() * 10, side: 1,
      pos: new Float32Array(n * 3), curA: new Float32Array(n - 1), curP: new Float32Array(n - 1), out: new Uint8Array(n),
    };
  }

  /** absA: absolute heading of the parent at the attach node */
  private addChild(pi: number, attach: number, depth: 1 | 2, R: () => number, absA: number) {
    const p = this.branches[pi];
    const L = this.L;
    this.sideFlip = -this.sideFlip;
    const side = R() < 0.75 ? this.sideFlip : -this.sideFlip;
    const len = depth === 1 ? (0.14 + R() * 0.2) * L : (0.045 + R() * 0.08) * L;
    const segL = depth === 1 ? 0.034 * L : 0.022 * L;
    const n = Math.max(2, Math.round(len / segL));
    const br = this.newBr(depth, n + 1);
    br.parent = pi;
    br.attach = attach;
    br.side = side;
    br.pendant = depth === 2 && R() < 0.3;
    let A = absA + side * (0.45 + R() * 0.55);
    const A0 = A;
    const target = br.pendant ? Math.sign(A || 1) * 2.7 : 0; // pendant twigs hang, others reach up
    const pull = br.pendant ? 0.22 : 0.06;
    let kink = 0;
    for (let m = 0; m < n; m++) {
      if (m % 2 === 0) kink = (R() - 0.5) * 0.35;
      A += (target - A) * pull + (R() - 0.5) * 0.12;
      br.restA[m] = A + kink - absA;
      const f = m / n;
      br.restP[m] = br.pendant ? (0.75 + R() * 0.25) * (1 - 0.5 * f) : depth === 1 ? 0.08 + R() * 0.16 : 0.12 + R() * 0.3;
      br.seg[m] = segL * (0.85 + R() * 0.3);
    }
    br.pressA = Math.sign(A0 || 1) * 0.25;
    const r0 = p.rad[attach] * (depth === 1 ? 0.62 : 0.6);
    for (let m = 0; m <= n; m++) br.rad[m] = lerp(r0, 0.0014 * L, Math.pow(m / n, 0.9));
    if (depth === 1) {
      br.modes.push(this.mode(0, 1.0 + R() * 0.4, 0.1), this.mode(Math.round(n / 2), 1.8 + R() * 0.6, 0.1));
      br.rk = 55;
      br.rc = 2 * 0.34 * Math.sqrt(55);
    } else {
      br.modes.push(this.mode(0, 2.4 + R() * 1.2, 0.1));
      br.rk = 95;
      br.rc = 2 * 0.26 * Math.sqrt(95);
    }
    const bi = this.branches.length;
    this.branches.push(br);
    if (depth === 1) {
      this.addBlooms(bi, R, 2, n, 0.26, 0.1, true);
      let m = 1 + ((R() * 2) | 0);
      let a = absA + br.restA[0];
      while (m < n) {
        a = absA + br.restA[m];
        this.addChild(bi, m, 2, R, a);
        m += 2 + ((R() * 2) | 0);
      }
    } else {
      this.addBlooms(bi, R, 1, n, br.pendant ? 0.55 : 0.5, 0.14, true);
    }
  }

  private addBlooms(bi: number, R: () => number, from: number, to: number, pF: number, pB: number, tipCluster: boolean) {
    for (let node = from; node <= to; node++) {
      const r = R();
      if (node === to && tipCluster) {
        if (r < 0.45) this.addBloom(bi, node, BT.Flower, R);
        else this.addBloom(bi, node, BT.Bud, R);
        if (R() < 0.5) this.addBloom(bi, node, BT.Bud, R);
        if (R() < 0.3) this.addBloom(bi, node, BT.Leaf, R);
        continue;
      }
      if (r < pF) {
        this.addBloom(bi, node, BT.Flower, R);
        if (R() < 0.12) this.addBloom(bi, node, BT.Flower, R);
      } else if (r < pF + pB) this.addBloom(bi, node, BT.Bud, R);
      if (R() < 0.05) this.addBloom(bi, node, BT.Leaf, R);
    }
  }

  private addBloom(bi: number, node: number, type: BT, R: () => number) {
    const br = this.branches[bi];
    const L = this.L;
    const psi = Math.PI / 2 + (R() - 0.5) * Math.PI * 1.5;
    const roff = br.rad[node] + (type === BT.Leaf ? 0.001 : 0.004) * L;
    const tint = new THREE.Color(1, 1, 1);
    const tr = R();
    if (tr < 0.16) tint.setRGB(1, 0.9, 0.91);
    else if (tr < 0.48) tint.setRGB(1, 0.965, 0.955);
    else if (tr < 0.6) tint.setRGB(0.96, 0.985, 0.99);
    const bl: Bloom = {
      type, br: bi, node,
      ot: (R() - 0.5) * 0.004 * L, on: Math.cos(psi) * roff, ob: Math.sin(psi) * roff,
      at: type === BT.Bud ? 0.9 : 0.1 + R() * 0.5, an: Math.cos(psi), ab: Math.sin(psi),
      bias: type === BT.Flower ? 0.3 + R() * 0.7 : 0.2,
      size: (type === BT.Flower ? 0.019 + R() * 0.008 : type === BT.Bud ? 0.02 + R() * 0.007 : 0.03 + R() * 0.014) * L,
      spin: R() * Math.PI * 2,
      tilt: 0.12 + R() * 0.38,
      b: 0, delay: R() * 0.35, rate: 1 / (0.55 + R() * 0.9), ph: R() * 10,
      petal0: -1, tint, slot: 0, x: 0, y: 0, z: 0,
    };
    if (type === BT.Leaf) {
      bl.an = R() < 0.5 ? 1 : -1;
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

  // ───────────────────────── meshes ─────────────────────────

  private buildMeshes(petalTex: THREE.Texture, R: () => number) {
    let nSeg = 0, nJoint = 0;
    for (const b of this.branches) {
      nSeg += b.n - 1;
      nJoint += b.n;
    }
    const bark = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86 });
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0);
    this.segMesh = new THREE.InstancedMesh(cyl, bark, nSeg);
    this.jointMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), bark, nJoint);
    const c = new THREE.Color();
    const c0 = [new THREE.Color('#2f2822'), new THREE.Color('#40332a'), new THREE.Color('#5a4433')];
    const c1 = [new THREE.Color('#4a3a2e'), new THREE.Color('#6b5040'), new THREE.Color('#7d6a3e')];
    let si = 0, ji = 0;
    for (const b of this.branches) {
      for (let j = 0; j < b.n; j++) {
        const f = Math.pow(j / (b.n - 1), 1.4);
        c.copy(c0[b.depth]).lerp(c1[b.depth], f).multiplyScalar(0.9 + R() * 0.2);
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

    const FALL = 16;
    this.fallMesh = new THREE.InstancedMesh(petalGeometry(VARIANTS[0]), petalMat, FALL);
    this.fallMesh.castShadow = true;
    this.fallMesh.receiveShadow = true;
    this.fallMesh.frustumCulled = false;
    for (let i = 0; i < FALL; i++) {
      this.fallen.push({ on: false, landed: -1, off: new THREE.Vector3(), p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), life: 0, s: 0, ph: i * 1.7, born: 0 });
      this.fallMesh.setMatrixAt(i, this.m1.makeScale(0, 0, 0));
    }
    this.group.add(this.segMesh, this.jointMesh, ...this.petalMeshes, this.centerMesh, this.budMesh, this.leafMesh, this.fallMesh);
    this.silhouette = [this.segMesh, this.jointMesh, ...this.petalMeshes, this.budMesh, this.leafMesh];
  }

  // ───────────────────────── simulation ─────────────────────────

  stats() {
    let fl = 0, open = 0, landed = 0;
    for (const b of this.blooms)
      if (b.type === BT.Flower) {
        fl++;
        if (b.b > 0.5) open++;
      }
    for (const f of this.fallen) if (f.on && f.landed >= 0) landed++;
    return { branches: this.branches.length, flowers: fl, bloomed: open, petalsOnLinen: landed };
  }

  update(dt: number, ctx: TreeCtx) {
    const t = ctx.time;
    const cur = ctx.curtain;
    const zCap = cur.o.zMin - 0.04;

    for (let bi = 0; bi < this.branches.length; bi++) {
      const br = this.branches[bi];
      const parent = br.depth === 0 ? null : this.branches[br.parent];
      let bx: number, by: number, bz: number, baseA = 0, baseP = 0;
      if (parent) {
        const ai = br.attach;
        bx = parent.pos[ai * 3];
        by = parent.pos[ai * 3 + 1];
        bz = parent.pos[ai * 3 + 2];
        baseA = parent.curA[Math.min(ai, parent.n - 2)];
        baseP = parent.curP[Math.min(ai, parent.n - 2)];
        // springs free once the linen no longer covers where it grows from
        const free = parent.out[ai] === 1 ? 1 : 0;
        br.rv += (br.rk * (free - br.r) - br.rc * br.rv) * dt;
        br.r = clamp(br.r + br.rv * dt, -0.3, 1.5);
      } else {
        bx = br.base.x;
        by = br.base.y;
        bz = br.base.z;
      }
      const rr = clamp(br.r, 0, 1);

      // sway: wind (only where uncovered), the passing hem, a gust on fast pulls, parent motion
      const hv = cur.hemVel(bx);
      const near = Math.exp(-(((by - cur.hemY(bx)) / (0.25 * this.L)) ** 2));
      br.acc = 0;
      for (let mi = 0; mi < br.modes.length; mi++) {
        const m = br.modes[mi];
        const amp = br.depth === 0 ? 0.004 : br.depth === 1 ? 0.022 : 0.05;
        const wind = (Math.sin(t * 0.9 + br.phase + mi) * 0.6 + Math.sin(t * 2.13 + br.phase * 1.7) * 0.3 + Math.sin(t * 0.37 + br.phase * 0.5) * 0.5) * amp * (1 + ctx.wave * 2) * (0.2 + 0.8 * rr);
        let Fa = m.k * (wind - m.a) - m.c * m.av;
        let Fp = m.k * (wind * 0.6 - m.p) - m.c * m.pv;
        if (br.depth > 0) {
          Fa += hv * near * br.side * 9 + -parent!.acc * 0.35;
          Fp += hv * near * 6 + br.rv * 1.5;
        }
        m.av += Fa * dt;
        m.a = clamp(m.a + m.av * dt, -0.8, 0.8);
        m.pv += Fp * dt;
        m.p = clamp(m.p + m.pv * dt, -0.7, 0.7);
        br.acc += Fa;
      }

      // integrate the shape
      const pos = br.pos;
      pos[0] = bx;
      pos[1] = by;
      pos[2] = bz;
      let x = bx, y = by, z = bz;
      const nS = br.n - 1;
      const lenScale = br.depth === 0 ? 1 : br.depth === 1 ? 0.9 + 0.1 * br.r : 0.72 + 0.28 * br.r;
      let crossed = parent ? parent.out[br.attach] === 1 : false;
      br.out[0] = crossed ? 1 : 0;
      for (let j = 0; j < nS; j++) {
        let a = baseA + br.restA[j] + br.pressA * (1 - br.r);
        let p = baseP + br.restP[j] * br.r;
        if (br.depth === 0 || br.depth === 1) {
          for (const m of br.modes)
            if (j >= m.start) {
              a += m.a;
              p += m.p;
            }
        } else {
          const f = (j + 1) / nS;
          a += br.modes[0].a * f;
          p += br.modes[0].p * f;
        }
        br.curA[j] = a;
        br.curP[j] = p;
        const cp = Math.cos(p);
        const L = br.seg[j] * lenScale;
        x += Math.sin(a) * cp * L;
        y += Math.cos(a) * cp * L;
        z += Math.sin(p) * L;
        const r = br.rad[j + 1];
        const hz = cur.hf.sample(x, y);
        const covered = !Number.isNaN(hz);
        if (br.pendant && crossed) {
          // a hanging twig that has flopped over the hem stays in front of the linen
          if (covered && z < hz + 0.012 + r) z = hz + 0.012 + r;
        } else if (covered && z > zCap - r) {
          z = zCap - r;
        }
        // only where the hem has actually been pulled down can a twig flop over it
        if (!covered && (!br.pendant || cur.hemY(x) < cur.o.top - 0.08)) crossed = true;
        if (z < 0.03 + r) z = 0.03 + r;
        pos[(j + 1) * 3] = x;
        pos[(j + 1) * 3 + 1] = y;
        pos[(j + 1) * 3 + 2] = z;
        br.out[j + 1] = !covered || z > hz ? 1 : 0;
      }
    }

    this.writeBranches();
    this.writeBlooms(dt, ctx);
    this.updateFallen(dt, ctx);
  }

  private frame(br: Br, node: number) {
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

  private writeBlooms(dt: number, ctx: TreeCtx) {
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
      const exposed = ctx.exposed(v1.x, v1.y, v1.z);
      if (exposed) {
        // a short, random hesitation; a fast pull makes everything open at once
        if (bl.delay > 0) bl.delay -= dt * (1 + ctx.wave * 4);
        else bl.b = Math.min(1, bl.b + dt * bl.rate * (1 + ctx.wave * 1.8));
      } else if (bl.b < 0.35) bl.b = Math.max(0, bl.b - dt * 0.5);
      const o = bl.b <= 0 ? 0 : easeOutBack(bl.b);

      if (bl.type === BT.Leaf) {
        d.copy(T).multiplyScalar(Math.cos(bl.tilt)).addScaledVector(N, Math.sin(bl.tilt) * bl.an).addScaledVector(B, 0.35).normalize();
        v2.copy(B).addScaledVector(d, -B.dot(d)).normalize();
        const X = this.v3.crossVectors(d, v2);
        m1.makeBasis(X, d, v2);
        m2.makeRotationY(Math.sin(t * 2.4 + bl.ph) * 0.06 * (1 + ctx.wave * 3));
        m1.multiply(m2);
        const s = bl.size * (0.3 + 0.7 * o);
        m1.scale(S.set(s, s, s));
        m1.setPosition(v1);
        this.leafMesh.setMatrixAt(bl.slot, m1);
        continue;
      }

      d.set(0, 0, 0).addScaledVector(T, bl.at).addScaledVector(N, bl.an).addScaledVector(B, bl.ab).normalize();
      d.y += bl.bias * 0.15;
      d.z += bl.bias;
      d.normalize();
      q.setFromUnitVectors(Zw, d);
      const flutter = ctx.wave * 0.25 * Math.sin(t * 7 + bl.ph);
      // petals unfurl with a quarter twist, like a real blossom opening
      q2.setFromAxisAngle(Zw, bl.spin + flutter * 0.5 - (1 - Math.min(o, 1)) * 0.9);
      q.multiply(q2);

      if (bl.type === BT.Bud) {
        const s = bl.size * (0.6 + 0.4 * o);
        mF.compose(v1, q, S.set(s, s, s));
        this.budMesh.setMatrixAt(bl.slot, mF);
        continue;
      }

      const s = bl.size * (0.4 + 0.6 * o);
      mF.compose(v1, q, S.set(s, s, s));
      const cs = 0.4 + 0.6 * Math.min(o, 1);
      this.m1.copy(mF).scale(S.set(cs, cs, cs));
      this.centerMesh.setMatrixAt(bl.slot, this.m1);
      const breath = Math.sin(t * 1.3 + bl.ph) * 0.02;
      for (let k = 0; k < 5; k++) {
        const p = this.petals[bl.petal0 + k];
        const tilt = lerp(1.4, bl.tilt, o) + p.tilt * o + breath + flutter * (0.6 + 0.4 * Math.sin(k * 2.1));
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

  /** a few petals let go on a fast pull, drift over the hem and settle on the linen */
  private updateFallen(dt: number, ctx: TreeCtx) {
    const cur = ctx.curtain;
    this.fallCooldown -= dt;
    this.idleFall -= dt;
    let open: Bloom[] | null = null;
    const opened = () => (open ??= this.blooms.filter((b) => b.type === BT.Flower && b.b > 0.9));
    if (ctx.wave > 0.55 && this.fallCooldown <= 0 && opened().length > 4) {
      this.spawn(opened(), 2 + ((Math.random() * 3) | 0));
      this.fallCooldown = 1.4;
    }
    if (this.idleFall <= 0) {
      if (opened().length > 12) this.spawn(opened(), 1);
      this.idleFall = 7 + Math.random() * 7;
    }
    const { m1, S } = this;
    const t = ctx.time;
    const nrm = cur.geometry.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < this.fallen.length; i++) {
      const f = this.fallen[i];
      if (!f.on) continue;
      f.life += dt;
      if (f.landed >= 0) {
        const k = f.landed;
        f.p.fromArray(cur.pos, k * 3).add(f.off);
      } else {
        f.v.y -= 0.5 * dt;
        f.v.multiplyScalar(Math.exp(-2.2 * dt));
        f.v.x += Math.sin(t * 2.3 + f.ph) * 0.3 * dt;
        f.v.z += (Math.cos(t * 1.7 + f.ph) * 0.1 - 0.06) * dt;
        f.p.addScaledVector(f.v, dt);
        this.q2.setFromAxisAngle(this.v2.copy(f.w).normalize(), f.w.length() * dt * (0.6 + 0.4 * Math.sin(t * 3 + f.ph)));
        f.q.multiply(this.q2);
        const hz = cur.hf.sample(f.p.x, f.p.y);
        if (!Number.isNaN(hz)) {
          if (f.p.z < hz + 0.01) {
            // touch down: rest on the cloth and ride along with it
            const k = cur.nearest(f.p.x, f.p.y, f.p.z);
            f.landed = k;
            this.v3.fromArray(cur.pos, k * 3);
            const nz = this.v1.fromBufferAttribute(nrm, k).normalize();
            if (nz.z < 0) nz.negate();
            f.p.set(f.p.x, f.p.y, this.v3.z).addScaledVector(nz, 0.006);
            f.off.copy(f.p).sub(this.v3);
            this.q.setFromUnitVectors(Zw, nz);
            this.q2.setFromAxisAngle(Zw, Math.random() * Math.PI * 2);
            f.q.copy(this.q).multiply(this.q2);
          }
        }
        if (f.p.y < cur.o.top - cur.o.H || f.life > 14) f.on = false;
      }
      if (!f.on) {
        this.fallMesh.setMatrixAt(i, m1.makeScale(0, 0, 0));
        continue;
      }
      const s = f.s * Math.min(1, f.life * 4);
      m1.compose(f.p, f.q, S.set(s, s, s));
      this.fallMesh.setMatrixAt(i, m1);
    }
    this.fallMesh.instanceMatrix.needsUpdate = true;
  }

  private spawn(open: Bloom[], n: number) {
    for (let k = 0; k < n; k++) {
      let f = this.fallen.find((x) => !x.on);
      if (!f) {
        // recycle the petal that has rested longest
        f = this.fallen.reduce((a, b) => (a.born < b.born ? a : b));
      }
      const b = open[(Math.random() * open.length) | 0];
      f.on = true;
      f.landed = -1;
      f.life = 0;
      f.born = ++this.fallSerial;
      f.s = b.size * 0.95;
      f.p.set(b.x, b.y, b.z + 0.02);
      f.v.set((Math.random() - 0.5) * 0.3, 0.05 + Math.random() * 0.12, 0.35 + Math.random() * 0.25);
      f.q.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
      f.w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 3);
    }
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}
