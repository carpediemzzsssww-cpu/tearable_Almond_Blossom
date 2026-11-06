import * as THREE from 'three';
import { mulberry32 } from './util';

function makeCanvas(w: number, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Mineral blue-green paint, with thin scumbled layers and changing brush flow.
 * Colour reference: Van Gogh Museum, Almond Blossom, s0176V1962.
 * This is generated paint texture; no part of the painting is used as an asset.
 */
export function wallTextures(aniso: number, size = 1024) {
  const S = size, k = S / 1024, tau = Math.PI * 2;
  const c = makeCanvas(S), g = c.getContext('2d')!;
  const b = makeCanvas(S), h = b.getContext('2d')!;
  const R = mulberry32(11);
  g.fillStyle = '#52959e';
  g.fillRect(0, 0, S, S);
  h.fillStyle = '#808080';
  h.fillRect(0, 0, S, S);

  const wrap = (x: number, y: number, radius: number, fn: (ox: number, oy: number) => void) => {
    for (const ox of [-S, 0, S])
      for (const oy of [-S, 0, S]) {
        if (x + ox + radius < 0 || x + ox - radius > S || y + oy + radius < 0 || y + oy - radius > S) continue;
        fn(ox, oy);
      }
  };

  // Transparent underpainting: broad cool and green passages remain visible
  // between the smaller marks, rather than one flat cyan coat.
  const washes = ['#5b9fa3', '#397e91', '#71aaa8', '#4a909e', '#699fa5'];
  for (let i = 0; i < 46; i++) {
    const x = R() * S, y = R() * S, r = (100 + R() * 220) * k;
    const colour = washes[(R() * washes.length) | 0];
    wrap(x, y, r, (ox, oy) => {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, colour);
      gr.addColorStop(1, `rgba(${parseInt(colour.slice(1, 3), 16)},${parseInt(colour.slice(3, 5), 16)},${parseInt(colour.slice(5, 7), 16)},0)`);
      g.globalAlpha = 0.22;
      g.fillStyle = gr;
      g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    });
  }

  const tones = ['#408490', '#5c9fa6', '#67a7a8', '#438d9c', '#7ab0ad', '#55999c', '#35818e', '#8ab7b0'];
  // Broad translucent strokes, then finer broken strokes. Width tapers along
  // each mark; a few separated bristles keep them from reading as little tiles.
  for (let layer = 0; layer < 2; layer++) {
    const count = layer === 0 ? 1350 : 3600;
    for (let i = 0; i < count; i++) {
      const x = R() * S, y = R() * S;
      const u = x / S * tau, v = y / S * tau;
      const ang = Math.atan2(Math.sin(u + 0.7 * Math.sin(v)) * 0.8 + 0.35,
        Math.cos(v) * 0.75 + Math.sin(2 * u + v) * 0.4) + (R() - 0.5) * 1.4;
      const len = (layer === 0 ? 30 + R() * 65 : 7 + R() * 32) * k;
      const width = (layer === 0 ? 8 + R() * 19 : 1.8 + R() * 5.5) * k;
      const bend = (R() - 0.5) * len * 0.4;
      const colour = tones[(R() * tones.length) | 0];
      const alpha = layer === 0 ? 0.07 + R() * 0.12 : 0.12 + R() * 0.18;
      const uneven = 0.2 + R() * 0.5;
      const shade = Math.round(132 + R() * 23);
      const bristles = 2 + ((R() * 4) | 0);
      wrap(x, y, len, (ox, oy) => {
        for (const ctx of [g, h]) {
          ctx.save();
          ctx.translate(x + ox, y + oy);
          ctx.rotate(ang);
          ctx.globalAlpha = ctx === g ? alpha : (layer === 0 ? 0.12 : 0.26);
          ctx.fillStyle = ctx === g ? colour : `rgb(${shade},${shade},${shade})`;
          ctx.beginPath();
          ctx.moveTo(-len * 0.5, width * 0.15);
          ctx.quadraticCurveTo(-len * 0.3, bend - width * 0.6, len * 0.46, -width * uneven);
          ctx.lineTo(len * 0.5, width * 0.1);
          ctx.quadraticCurveTo(len * 0.1, bend + width * 0.55, -len * 0.43, width * uneven);
          ctx.closePath();
          ctx.fill();
          // Very shallow dragged bristle ridges. The light catches these
          // occasionally, without giving every mark a hard bevel.
          if (layer === 1) {
            ctx.strokeStyle = ctx === g ? '#b0cdc1' : '#a0a0a0';
            ctx.globalAlpha = ctx === g ? alpha * 0.25 : 0.13;
            ctx.lineWidth = k * 0.55;
            for (let j = 0; j < bristles; j++) {
              const f = (j + 0.5) / bristles - 0.5;
              ctx.beginPath();
              ctx.moveTo(-len * (0.27 + uneven * 0.18), f * width);
              ctx.quadraticCurveTo(0, bend + f * width, len * 0.38, f * width * 0.6);
              ctx.stroke();
            }
          }
          ctx.restore();
        }
      });
    }
  }
  g.globalAlpha = h.globalAlpha = 1;
  // Quiet pigment tooth, below the contrast of the brush marks.
  const img = g.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const grain = (R() - 0.5) * 3;
    img.data[i] += grain;
    img.data[i + 1] += grain;
    img.data[i + 2] += grain;
  }
  g.putImageData(img, 0, 0);

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const bump = new THREE.CanvasTexture(b);
  for (const t of [map, bump]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
    t.minFilter = THREE.LinearMipmapLinearFilter;
  }
  return { map, bump };
}

/** Soft, irregular linen yarns. Crossing relief is subtle, not a checkerboard. */
export function linenTextures(aniso: number) {
  const S = 768, T = 96, tau = Math.PI * 2;
  const R = mulberry32(5);
  // Unequal yarn spacing is periodic at the tile boundary. It breaks the
  // regular pixel grid without introducing a visible seam in a folded panel.
  const yarns = () => {
    const width = new Float32Array(T), center = new Float32Array(T);
    const colour = new Float32Array(T), phase = new Float32Array(T);
    const thick = new Float32Array(T), slubY = new Float32Array(T), slubL = new Float32Array(T);
    let sum = 0;
    for (let i = 0; i < T; i++) {
      width[i] = 0.82 + R() * 0.36;
      sum += width[i];
      colour[i] = 0.988 + R() * 0.024;
      phase[i] = R() * tau;
      thick[i] = 0.85 + R() * 0.3;
      slubY[i] = R() * S;
      slubL[i] = R() < 0.35 ? 12 + R() * 28 : 0;
    }
    let at = 0;
    for (let i = 0; i < T; i++) {
      width[i] *= S / sum;
      center[i] = at + width[i] * 0.5;
      at += width[i];
    }
    const index = new Uint8Array(S);
    let j = 0;
    for (let x = 0; x < S; x++) {
      while (j < T - 1 && x + 0.5 >= center[j] + width[j] * 0.5) j++;
      index[x] = j;
    }
    return { width, center, colour, phase, thick, slubY, slubL, index };
  };
  const warp = yarns(), weft = yarns();
  const height = new Float32Array(S * S), colour = new Float32Array(S * S);
  const periodicDistance = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return Math.min(d, S - d);
  };
  const profile = (d: number, thickness: number) => Math.pow(Math.max(0, Math.cos(Math.PI * d)), 0.55 / thickness);
  for (let y = 0; y < S; y++) {
    const j = weft.index[y];
    for (let x = 0; x < S; x++) {
      const i = warp.index[x];
      const warpSlub = warp.slubL[i] > 0 ? Math.exp(-((periodicDistance(y, warp.slubY[i]) / warp.slubL[i]) ** 2)) : 0;
      const weftSlub = weft.slubL[j] > 0 ? Math.exp(-((periodicDistance(x, weft.slubY[j]) / weft.slubL[j]) ** 2)) : 0;
      // Small meanders and uneven fibre thickness; all long waves tile exactly.
      const wx = (x + 0.5 - warp.center[i]) / warp.width[i] + Math.sin(y / S * tau * 3 + warp.phase[i]) * 0.025;
      const fy = (y + 0.5 - weft.center[j]) / weft.width[j] + Math.sin(x / S * tau * 2 + weft.phase[j]) * 0.022;
      const cw = profile(wx, warp.thick[i] * (1 + warpSlub * 0.26));
      const cf = profile(fy, weft.thick[j] * (1 + weftSlub * 0.23));
      const over = ((i + j) & 1) === 0;
      const wh = cw * (over ? 0.61 : 0.58);
      const fh = cf * (over ? 0.58 : 0.61);
      const lift = Math.max(wh, fh);
      const tooth = 0.004 * Math.sin(x / S * tau * 5 + Math.sin(y / S * tau * 3));
      height[y * S + x] = lift + (warpSlub + weftSlub) * 0.025;
      const threadColour = (warp.colour[i] * (cw + 0.05) + weft.colour[j] * (cf + 0.05)) / (cw + cf + 0.1);
      colour[y * S + x] = (0.978 + 0.022 * lift) * threadColour + tooth - (warpSlub + weftSlub) * 0.004;
    }
  }
  const c = makeCanvas(S), g = c.getContext('2d')!;
  const n = makeCanvas(S), gn = n.getContext('2d')!;
  const ci = g.createImageData(S, S), ni = gn.createImageData(S, S);
  // Undyed, warm grey flax rather than yellow canvas; the scene provides warmth.
  const base = [228, 223, 211], strength = 0.85;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const v = colour[i], grain = (R() - 0.5) * 0.9;
      ci.data[i * 4] = base[0] * v + grain;
      ci.data[i * 4 + 1] = base[1] * v + grain;
      ci.data[i * 4 + 2] = base[2] * v + grain;
      ci.data[i * 4 + 3] = 255;
      const hl = height[y * S + ((x - 1 + S) % S)], hr = height[y * S + ((x + 1) % S)];
      const hu = height[((y - 1 + S) % S) * S + x], hd = height[((y + 1) % S) * S + x];
      const nx = (hl - hr) * strength, ny = (hd - hu) * strength;
      const l = Math.hypot(nx, ny, 1);
      ni.data[i * 4] = (nx / l * 0.5 + 0.5) * 255;
      ni.data[i * 4 + 1] = (ny / l * 0.5 + 0.5) * 255;
      ni.data[i * 4 + 2] = (0.5 / l + 0.5) * 255;
      ni.data[i * 4 + 3] = 255;
    }
  g.putImageData(ci, 0, 0);
  gn.putImageData(ni, 0, 0);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const normal = new THREE.CanvasTexture(n);
  for (const t of [map, normal]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
    t.minFilter = THREE.LinearMipmapLinearFilter;
  }
  return { map, normal };
}

/** Muted, longitudinal bark scumbling. Light marks follow the branch, never form rings. */
export function barkTextures(aniso = 4) {
  const W = 256, H = 512, tau = Math.PI * 2;
  const R = mulberry32(1891);
  const c = makeCanvas(W, H), g = c.getContext('2d')!;
  const b = makeCanvas(W, H), h = b.getContext('2d')!;
  const ci = g.createImageData(W, H), bi = h.createImageData(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const u = x / W * tau, v = y / H * tau;
      const grain = Math.sin(u * 17 + Math.sin(v * 2) * 0.5) * 1.1 + (R() - 0.5) * 1.8;
      ci.data[i] = 241 + grain;
      ci.data[i + 1] = 241 + grain;
      ci.data[i + 2] = 228 + grain;
      ci.data[i + 3] = 255;
      bi.data[i] = bi.data[i + 1] = bi.data[i + 2] = 128 + grain * 0.4;
      bi.data[i + 3] = 255;
    }
  const shades = [[158, 175, 146], [204, 182, 132], [255, 251, 220]];
  for (let mark = 0; mark < 180; mark++) {
    const cx = R() * W, cy = R() * H;
    const width = 1.2 + R() * 4.2, length = 10 + R() * 48;
    const type = (R() * shades.length) | 0, shade = shades[type];
    const opacity = type === 2 ? 0.18 + R() * 0.13 : 0.1 + R() * 0.1;
    const phase = R() * tau;
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        const px = cx + ox * W, py = cy + oy * H;
        const y0 = Math.max(0, Math.floor(py - length * 1.6)), y1 = Math.min(H - 1, Math.ceil(py + length * 1.6));
        const x0 = Math.max(0, Math.floor(px - width * 3)), x1 = Math.min(W - 1, Math.ceil(px + width * 3));
        for (let y = y0; y <= y1; y++) {
          const dy = (y - py) / length;
          const bend = Math.sin(dy * 0.8 + phase) * width * 0.45;
          for (let x = x0; x <= x1; x++) {
            const dx = (x - px - bend) / width;
            const alpha = Math.exp(-dx * dx * 1.5 - dy ** 4) * opacity;
            const i = (y * W + x) * 4;
            for (let channel = 0; channel < 3; channel++) ci.data[i + channel] += (shade[channel] - ci.data[i + channel]) * alpha;
            const relief = (type === 0 ? -10 : 11) * alpha;
            bi.data[i] = bi.data[i + 1] = bi.data[i + 2] = bi.data[i] + relief;
          }
        }
      }
  }
  g.putImageData(ci, 0, 0);
  h.putImageData(bi, 0, 0);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const bump = new THREE.CanvasTexture(b);
  for (const t of [map, bump]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.anisotropy = aniso;
  }
  return { map, bump };
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
