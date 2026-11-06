import * as THREE from 'three';

const mini = import.meta.env.MODE === 'minitool';

type V = [number, number, number];

/** tiny triangle soup builder with vertex colours (non-indexed, flat normals) */
class Soup {
  pos: number[] = [];
  col: number[] = [];
  tri(a: V, b: V, c: V, ca: THREE.Color, cb = ca, cc = ca) {
    this.pos.push(...a, ...b, ...c);
    this.col.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);
  }
  prism(p0: V, p1: V, r0: number, r1: number, c0: THREE.Color, c1: THREE.Color, sides = 3) {
    const d = new THREE.Vector3(...p1).sub(new THREE.Vector3(...p0)).normalize();
    const ref = Math.abs(d.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(d, ref).normalize();
    const v = new THREE.Vector3().crossVectors(d, u);
    const ring = (p: V, r: number, th: number): V => [
      p[0] + r * (Math.cos(th) * u.x + Math.sin(th) * v.x),
      p[1] + r * (Math.cos(th) * u.y + Math.sin(th) * v.y),
      p[2] + r * (Math.cos(th) * u.z + Math.sin(th) * v.z),
    ];
    for (let k = 0; k < sides; k++) {
      const t0 = (k / sides) * Math.PI * 2, t1 = ((k + 1) / sides) * Math.PI * 2;
      const a0 = ring(p0, r0, t0), a1 = ring(p0, r0, t1), b0 = ring(p1, r1, t0), b1 = ring(p1, r1, t1);
      this.tri(a0, a1, b1, c0, c0, c1);
      this.tri(a0, b1, b0, c0, c1, c1);
    }
  }
  blob(c: V, sx: number, sy: number, sz: number, color: THREE.Color) {
    for (const ax of [-1, 1])
      for (const ay of [-1, 1])
        for (const az of [-1, 1]) {
          const a: V = [c[0] + ax * sx, c[1], c[2]], b: V = [c[0], c[1] + ay * sy, c[2]], d: V = [c[0], c[1], c[2] + az * sz];
          if (ax * ay * az > 0) this.tri(a, b, d, color);
          else this.tri(a, d, b, color);
        }
  }
  addGeometry(g: THREE.BufferGeometry, colorAt: (p: THREE.Vector3) => THREE.Color) {
    const ng = g.index ? g.toNonIndexed() : g;
    const p = ng.getAttribute('position');
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const c = colorAt(v);
      this.pos.push(v.x, v.y, v.z);
      this.col.push(c.r, c.g, c.b);
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

const C = (hex: string) => new THREE.Color(hex);

/**
 * Petal in local space: claw at the origin, blade along +Y (length 1), inner face +Z.
 * Broad obovate almond petal with cupping, a little curl and edge ruffle.
 */
export function petalGeometry(o: { w: number; cup: number; curl: number; ruffle: number; skew: number }) {
  const NU = mini ? 3 : 6, NV = mini ? 4 : 10;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let iv = 0; iv <= NV; iv++) {
    const t = iv / NV;
    const wt = t < 0.6 ? 0.16 + 0.84 * Math.sin((Math.PI / 2) * (t / 0.6)) : Math.sqrt(Math.max(0, 1 - ((t - 0.6) / 0.4) ** 2));
    const half = o.w * Math.max(wt, 0.02);
    for (let iu = 0; iu <= NU; iu++) {
      const s = (iu / NU) * 2 - 1;
      const x = s * half + o.skew * t * t;
      const y = t * (1 - 0.04 * s * s);
      const z = o.cup * s * s * half * 1.6 * Math.sqrt(t) + o.curl * t * t + o.ruffle * Math.sin(s * 8 + t * 5) * t * t * half;
      pos.push(x, y, z);
      uv.push(s * 0.5 + 0.5, t);
    }
  }
  for (let iv = 0; iv < NV; iv++)
    for (let iu = 0; iu < NU; iu++) {
      const a = iv * (NU + 1) + iu, b = a + 1, c = a + NU + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** receptacle, stamens and sepals, in petal-length units, axis +Z */
export function centerGeometry(seed: () => number) {
  const s = new Soup();
  const dome = new THREE.SphereGeometry(0.11, mini ? 6 : 10, mini ? 3 : 6);
  dome.scale(1, 1, 0.5);
  const dark = C('#8a3440'), gold = C('#b9963e');
  s.addGeometry(dome, (p) => (p.z > 0.03 ? gold : dark));
  const fil0 = C('#d98d9a'), fil1 = C('#f6ece8'), anther = C('#e2b03c'), pollen = C('#c9862a');
  const N = 24;
  for (let k = 0; k < N; k++) {
    const phi = k * 2.39996 + seed() * 0.3;
    const el = 0.42 + seed() * 0.42;
    const L = 0.3 + seed() * 0.14;
    const r0 = 0.05 + seed() * 0.03;
    const p0: V = [Math.cos(phi) * r0, Math.sin(phi) * r0, 0.02];
    const p1: V = [p0[0] + Math.cos(phi) * Math.sin(el) * L, p0[1] + Math.sin(phi) * Math.sin(el) * L, 0.02 + Math.cos(el) * L];
    const colour = seed() < 0.3 ? pollen : anther;
    // Consume the same random samples so tree placement stays identical.
    if (!mini || k % 12 === 0) {
      s.prism(p0, p1, 0.007, 0.005, fil0, fil1);
      s.blob(p1, 0.022, 0.022, 0.016, colour);
    }
  }
  // pistil
  s.prism([0, 0, 0.03], [0.01, 0, 0.36], 0.012, 0.008, C('#a9b45a'), C('#cfd27a'));
  s.blob([0.01, 0, 0.37], 0.02, 0.02, 0.012, C('#b7b860'));
  // sepals, folded back behind the petals
  const sep = C('#6d2a30');
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3;
    const ca = Math.cos(a), sa = Math.sin(a);
    const w = 0.07;
    s.tri([ca * 0.06 - sa * w, sa * 0.06 + ca * w, -0.02], [ca * 0.06 + sa * w, sa * 0.06 - ca * w, -0.02], [ca * 0.2, sa * 0.2, -0.14], sep);
  }
  return s.build();
}

/** closed almond bud: rose base, five faint lobes, pale tip; axis +Z */
export function budGeometry() {
  const s = new Soup();
  const g = new THREE.SphereGeometry(1, mini ? 6 : 14, mini ? 4 : 10);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const lobe = 1 + 0.07 * Math.cos(5 * Math.atan2(y, x));
    const taper = z > 0 ? 1 - 0.25 * z * z : 1;
    p.setXYZ(i, x * 0.15 * lobe * taper, y * 0.15 * lobe * taper, z * 0.26 + 0.22);
  }
  const base = C('#c4596a'), mid = C('#e59aa5'), tip = C('#f7e5e3');
  const tmp = new THREE.Color();
  s.addGeometry(g, (v) => {
    const t = (v.z + 0.04) / 0.52;
    return t < 0.5 ? tmp.copy(base).lerp(mid, t / 0.5).clone() : tmp.copy(mid).lerp(tip, (t - 0.5) / 0.5).clone();
  });
  const sep = C('#6b2a2e');
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a), w = 0.07;
    s.tri([ca * 0.03 - sa * w, sa * 0.03 + ca * w, -0.02], [ca * 0.03 + sa * w, sa * 0.03 - ca * w, -0.02], [ca * 0.16, sa * 0.16, 0.13], sep);
  }
  s.prism([0, 0, -0.12], [0, 0, 0.0], 0.03, 0.04, C('#5a3a2c'), C('#6b2a2e'), 5);
  return s.build();
}

/** young almond leaf, lanceolate, folded along the midrib; length 1 along +Y */
export function leafGeometry() {
  const NU = mini ? 2 : 4, NV = mini ? 4 : 9;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const base = C('#5f7a32'), tipc = C('#a9be5c'), rib = C('#c9d58a');
  const tmp = new THREE.Color();
  for (let iv = 0; iv <= NV; iv++) {
    const t = iv / NV;
    const half = 0.17 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.02)), 0.8) * (1 - 0.3 * t);
    for (let iu = 0; iu <= NU; iu++) {
      const s = (iu / NU) * 2 - 1;
      pos.push(s * half, t, Math.abs(s) * half * 0.7 + 0.1 * t * t);
      tmp.copy(base).lerp(tipc, t * 0.8 + Math.abs(s) * 0.15);
      if (iu === NU / 2) tmp.lerp(rib, 0.35);
      col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  for (let iv = 0; iv < NV; iv++)
    for (let iu = 0; iu < NU; iu++) {
      const a = iv * (NU + 1) + iu, b = a + 1, c = a + NU + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
