import * as THREE from 'three';
import { mulberry32 } from './util';

function makeCanvas(w: number, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Turquoise wall in the spirit of "Almond Blossom" (1890):
 * short directional strokes in several blue-greens, plus a matching bump map
 * so raking light catches the impasto.
 */
export function wallTextures(aniso: number, size = 1024) {
  const S = size;
  const c = makeCanvas(S);
  const g = c.getContext('2d')!;
  const b = makeCanvas(S);
  const h = b.getContext('2d')!;
  const R = mulberry32(11);

  g.fillStyle = '#80c0c8';
  g.fillRect(0, 0, S, S);
  h.fillStyle = 'rgb(128,128,128)';
  h.fillRect(0, 0, S, S);

  const wrap = (x: number, y: number, r: number, fn: (ox: number, oy: number) => void) => {
    for (const ox of [-S, 0, S])
      for (const oy of [-S, 0, S]) {
        if (x + ox + r < 0 || x + ox - r > S || y + oy + r < 0 || y + oy - r > S) continue;
        fn(ox, oy);
      }
  };

  // broad, quiet mottling
  const blobs = ['#8ac6cc', '#78b6c0', '#96cfd0', '#7fbcc4', '#a2d4d2'];
  for (let i = 0; i < 60; i++) {
    const x = R() * S, y = R() * S, r = (80 + R() * 220) * (S / 1024);
    const col = blobs[(R() * blobs.length) | 0];
    wrap(x, y, r, (ox, oy) => {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, col);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = 0.2;
      g.fillStyle = gr;
      g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    });
  }

  // short brush strokes following a slow flow field
  const tones = ['#88c6cc', '#79b8c2', '#96cfd0', '#74b2bf', '#a6d8d4', '#84c2c8', '#b4dfda', '#7cbcc6'];
  const k = S / 1024;
  g.lineCap = 'round';
  h.lineCap = 'round';
  for (let i = 0; i < 3800; i++) {
    const x = R() * S, y = R() * S;
    const ang = Math.sin(x * 0.006 / k + 1.3) * 0.9 + Math.cos(y * 0.0045 / k) * 0.7 + (R() - 0.5) * 0.9;
    const len = (8 + R() * 20) * k;
    const wid = (4.5 + R() * 5) * k;
    const col = tones[(R() * tones.length) | 0];
    const a = 0.06 + R() * 0.15;
    const bend = (R() - 0.5) * 0.45 * len;
    const dx = (Math.cos(ang) * len) / 2, dy = (Math.sin(ang) * len) / 2;
    const nx = -Math.sin(ang) * bend, ny = Math.cos(ang) * bend;
    const shade = (115 + R() * 70) | 0;
    wrap(x, y, len, (ox, oy) => {
      g.globalAlpha = a;
      g.strokeStyle = col;
      g.lineWidth = wid;
      g.beginPath();
      g.moveTo(x - dx + ox, y - dy + oy);
      g.quadraticCurveTo(x + nx + ox, y + ny + oy, x + dx + ox, y + dy + oy);
      g.stroke();
      h.globalAlpha = 0.45;
      h.strokeStyle = `rgb(${shade},${shade},${shade})`;
      h.lineWidth = wid * 0.85;
      h.beginPath();
      h.moveTo(x - dx + ox, y - dy + oy);
      h.quadraticCurveTo(x + nx + ox, y + ny + oy, x + dx + ox, y + dy + oy);
      h.stroke();
    });
  }
  g.globalAlpha = 1;
  h.globalAlpha = 1;

  // fine plaster grain
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (R() - 0.5) * 7;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  // soften the bump so it reads as paint, not noise
  const b2 = makeCanvas(S);
  const h2 = b2.getContext('2d')!;
  h2.filter = 'blur(1.2px)';
  h2.drawImage(b, 0, 0);

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const bump = new THREE.CanvasTexture(b2);
  for (const t of [map, bump]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
  }
  return { map, bump };
}

/** Plain-weave linen: colour map with slubs + normal map from a thread height field. */
export function linenTextures(aniso: number) {
  const S = 512, P = 8, T = S / P;
  const R = mulberry32(5);
  const warpT = new Float32Array(T), weftT = new Float32Array(T);
  const warpC = new Float32Array(T), weftC = new Float32Array(T);
  const slubW: number[][] = [], slubF: number[][] = [];
  for (let i = 0; i < T; i++) {
    warpT[i] = 0.75 + R() * 0.5;
    weftT[i] = 0.75 + R() * 0.5;
    warpC[i] = 0.95 + R() * 0.08;
    weftC[i] = 0.94 + R() * 0.09;
    slubW.push(R() < 0.25 ? [R() * S, 10 + R() * 30] : []);
    slubF.push(R() < 0.25 ? [R() * S, 10 + R() * 30] : []);
  }
  const H = new Float32Array(S * S);
  const col = new Float32Array(S * S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = (x / P) | 0, j = (y / P) | 0;
      const fx = ((x % P) + 0.5) / P, fy = ((y % P) + 0.5) / P;
      const over = ((i + j) & 1) === 0;
      let sw = 1, sf = 1;
      const a = slubW[i], bb = slubF[j];
      if (a.length) sw += 0.35 * Math.exp(-(((y - a[0]) / a[1]) ** 2));
      if (bb.length) sf += 0.35 * Math.exp(-(((x - bb[0]) / bb[1]) ** 2));
      const cw = Math.pow(Math.sin(Math.PI * fx), 0.75 / (warpT[i] * sw));
      const cf = Math.pow(Math.sin(Math.PI * fy), 0.75 / (weftT[j] * sf));
      const sy = Math.sin(Math.PI * fy), sx = Math.sin(Math.PI * fx);
      const wh = cw * (over ? 0.75 + 0.25 * sy : 0.5 - 0.2 * sy);
      const fh = cf * (over ? 0.5 - 0.2 * sx : 0.75 + 0.25 * sx);
      const hh = Math.max(wh, fh);
      H[y * S + x] = hh;
      col[y * S + x] = (0.93 + 0.07 * hh) * (wh > fh ? warpC[i] : weftC[j]);
    }
  const c = makeCanvas(S), g = c.getContext('2d')!;
  const n = makeCanvas(S), gn = n.getContext('2d')!;
  const ci = g.createImageData(S, S), ni = gn.createImageData(S, S);
  const base = [236, 227, 210];
  const st = 2.2;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const k = y * S + x;
      const v = col[k];
      ci.data[k * 4] = base[0] * v;
      ci.data[k * 4 + 1] = base[1] * v;
      ci.data[k * 4 + 2] = base[2] * v;
      ci.data[k * 4 + 3] = 255;
      const hl = H[y * S + ((x - 1 + S) % S)], hr = H[y * S + ((x + 1) % S)];
      const hu = H[((y - 1 + S) % S) * S + x], hd = H[((y + 1) % S) * S + x];
      let nx = (hl - hr) * st, ny = (hd - hu) * st;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz);
      ni.data[k * 4] = ((nx / l) * 0.5 + 0.5) * 255;
      ni.data[k * 4 + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      ni.data[k * 4 + 2] = ((nz / l) * 0.5 + 0.5) * 255;
      ni.data[k * 4 + 3] = 255;
    }
  g.putImageData(ci, 0, 0);
  gn.putImageData(ni, 0, 0);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const normal = new THREE.CanvasTexture(n);
  for (const t of [map, normal]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
  }
  return { map, normal };
}

/** Almond petal: warm white, rose flush at the claw, faint fanning veins. v=0 base, v=1 tip. */
export function petalTexture() {
  const W = 128, H = 256;
  const c = makeCanvas(W, H), g = c.getContext('2d')!;
  const R = mulberry32(3);
  const lg = g.createLinearGradient(0, H, 0, 0);
  lg.addColorStop(0, '#e9b3b8');
  lg.addColorStop(0.16, '#f4d9d8');
  lg.addColorStop(0.42, '#fbf4ef');
  lg.addColorStop(1, '#fffcf7');
  g.fillStyle = lg;
  g.fillRect(0, 0, W, H);
  // rose eye at the base
  const rg = g.createRadialGradient(W / 2, H, 0, W / 2, H, 70);
  rg.addColorStop(0, 'rgba(196,92,110,0.55)');
  rg.addColorStop(1, 'rgba(196,92,110,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, W, H);
  // veins
  g.lineWidth = 0.9;
  for (let k = 0; k <= 18; k++) {
    const ex = W * (0.02 + (0.96 * k) / 18);
    g.strokeStyle = `rgba(205,160,160,${0.1 + R() * 0.12})`;
    g.beginPath();
    g.moveTo(W / 2 + (R() - 0.5) * 6, H);
    g.quadraticCurveTo(W / 2 + (ex - W / 2) * 0.35, H * 0.5, ex, H * (0.04 + Math.abs(ex - W / 2) / W * 0.5));
    g.stroke();
  }
  // edges a touch creamier (thinner tissue)
  const eg = g.createLinearGradient(0, 0, W, 0);
  eg.addColorStop(0, 'rgba(248,236,214,0.35)');
  eg.addColorStop(0.18, 'rgba(248,236,214,0)');
  eg.addColorStop(0.82, 'rgba(248,236,214,0)');
  eg.addColorStop(1, 'rgba(248,236,214,0.35)');
  g.fillStyle = eg;
  g.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
