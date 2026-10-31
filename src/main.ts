import * as THREE from 'three';
import { Curtain } from './curtain';
import { Tree } from './tree';
import { wallTextures, linenTextures, petalTexture } from './textures';
import { clamp } from './util';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const coarse = matchMedia('(pointer: coarse)').matches;
const lowTier = coarse || Math.min(innerWidth, innerHeight) < 640;

let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch {
  document.body.classList.add('no-webgl');
  throw new Error('WebGL unavailable');
}
const maxDpr = Math.min(window.devicePixelRatio || 1, 2);
let dpr = maxDpr;
renderer.setPixelRatio(dpr);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.55;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;

const BG = new THREE.Color('#9fd0d4');
const scene = new THREE.Scene();
scene.background = BG;
const CAM_Z = 6;
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 60);
camera.position.set(0, 0, CAM_Z);
camera.lookAt(0, 0, 0);

const viewAt = (z: number) => {
  const h = 2 * (CAM_Z - z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return { W: h * camera.aspect, H: h };
};

// ── light: low warm sun from the upper left, turquoise sky fill ──
scene.add(new THREE.HemisphereLight('#e8f6f6', '#c9bba0', 0.9));
const sun = new THREE.DirectionalLight('#fff5e8', 3.1);
sun.position.set(-2.6, 3.6, 4.6);
sun.castShadow = true;
const sm = lowTier ? 1024 : 2048;
sun.shadow.mapSize.set(sm, sm);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 14;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.015;
scene.add(sun);

const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

// ── the painting behind: turquoise wall with short strokes ──
const wt = wallTextures(aniso, lowTier ? 768 : 1024);
wt.map.repeat.set(3.4, 3.4);
wt.bump.repeat.set(3.4, 3.4);
const wall = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.MeshStandardMaterial({ map: wt.map, bumpMap: wt.bump, bumpScale: 0.3, roughness: 0.94 }),
);
wall.receiveShadow = true;
scene.add(wall);

// ── backlit silhouette of the tree, seen through the linen ──
const silRT = new THREE.WebGLRenderTarget(256, 256, {
  minFilter: THREE.LinearMipmapLinearFilter,
  magFilter: THREE.LinearFilter,
  generateMipmaps: true,
});
const silMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
const silCam = new THREE.PerspectiveCamera();
const WHITE = new THREE.Color(1, 1, 1);

// ── linen ──
const lt = linenTextures(aniso);
const linenU = {
  tSil: { value: silRT.texture },
  uRes: { value: new THREE.Vector2(1, 1) },
  uGlow: { value: 0.2 },
  uSize: { value: new THREE.Vector2(1, 1) },
};
const linen = new THREE.MeshPhysicalMaterial({
  map: lt.map,
  normalMap: lt.normal,
  normalScale: new THREE.Vector2(0.22, 0.22),
  roughness: 0.9,
  sheen: 0.7,
  sheenRoughness: 0.75,
  sheenColor: new THREE.Color('#fff4e2'),
  side: THREE.DoubleSide,
});
linen.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, linenU);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vRawUv;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\nvRawUv = uv;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vRawUv;\nuniform sampler2D tSil;\nuniform vec2 uRes;\nuniform float uGlow;\nuniform vec2 uSize;')
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      // turned hem with a running stitch
      float hy = (1.0 - vRawUv.y) * uSize.y;
      float band = 1.0 - smoothstep(0.05, 0.058, hy);
      diffuseColor.rgb *= mix(1.0, 0.95, band);
      diffuseColor.rgb *= 1.0 - 0.12 * (1.0 - smoothstep(0.0, 0.005, abs(hy - 0.055)));
      float st = (1.0 - smoothstep(0.002, 0.0045, abs(hy - 0.028))) * step(0.45, fract(vRawUv.x * uSize.x / 0.034));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.66, 0.55), st * 0.6);
      if (!gl_FrontFacing) diffuseColor.rgb *= vec3(0.8, 0.76, 0.72);`,
    )
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      // daylight through the weave, interrupted by the branches behind it
      vec2 suv = gl_FragCoord.xy / uRes;
      float sil = texture(tSil, suv + vec2(-0.004, -0.012), 2.2).r * 0.5 + texture(tSil, suv + vec2(-0.009, -0.024), 3.8).r * 0.5;
      float face = gl_FrontFacing ? 1.0 : 0.4;
      totalEmissiveRadiance += vec3(1.0, 0.9, 0.74) * uGlow * mix(0.5, 1.0, sil) * face;`,
    );
};

const petalTex = petalTexture();
let curtain: Curtain;
let tree: Tree;
const zCloth = 0.46;
let maxOpen = 0;

function build() {
  if (curtain) {
    scene.remove(curtain.mesh);
    curtain.dispose();
  }
  if (tree) {
    scene.remove(tree.group);
    tree.dispose();
  }
  const vc = viewAt(zCloth);
  const vt = viewAt(0.15);
  const portrait = camera.aspect < 0.8;
  curtain = new Curtain(linen, {
    W: vc.W * 1.32 + 0.5,
    H: vc.H * 1.4,
    top: vc.H / 2 + 0.12,
    z0: zCloth,
    zMin: 0.4,
    cols: lowTier ? 30 : 42,
    rows: lowTier ? 26 : 30,
  });
  if (lowTier) curtain.iterations = 10;
  curtain.viewW = vc.W;
  linenU.uSize.value.set(curtain.o.W, curtain.o.H);
  const tile = vc.H * 0.17;
  lt.map.repeat.set(curtain.o.W / tile, curtain.o.H / tile);
  lt.normal.repeat.copy(lt.map.repeat);
  scene.add(curtain.mesh);
  tree = new Tree(vt, petalTex, portrait ? 2026 : 1890);
  for (const m of tree.silhouette) m.layers.enable(1);
  scene.add(tree.group);
  const half = Math.max(vt.W, vt.H) / 2 + 0.8;
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half });
  sun.shadow.camera.updateProjectionMatrix();
  maxOpen = 0;
}

function size() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  const db = renderer.getDrawingBufferSize(new THREE.Vector2());
  linenU.uRes.value.copy(db);
  const sw = Math.round(clamp(innerWidth / 3, 160, 480));
  silRT.setSize(sw, Math.max(64, Math.round(sw / camera.aspect)));
}

size();
build();
let builtAspect = camera.aspect;
let resizeT = 0;
addEventListener('resize', () => {
  size();
  clearTimeout(resizeT);
  resizeT = window.setTimeout(() => {
    if (Math.abs(camera.aspect / builtAspect - 1) > 0.08) {
      builtAspect = camera.aspect;
      build();
    }
  }, 250);
});

// ── input ──
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const hit = new THREE.Vector3();
let drag: { id: number; start: THREE.Vector3 } | null = null;
let touched = false;

function worldAt(x: number, y: number, out: THREE.Vector3) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.ray.intersectPlane(plane, out);
}
function rubber(dx: number, dy: number) {
  const v = viewAt(zCloth);
  const mx = v.W * 0.16, my = v.H * 0.78, up = v.H * 0.04;
  return [mx * Math.tanh(dx / mx), dy < 0 ? -my * Math.tanh(-dy / my) : up * Math.tanh(dy / up)];
}
function grabAt(sx: number, sy: number) {
  const k = curtain.pick(camera, sx, sy, innerWidth, innerHeight, coarse ? 90 : 70);
  if (k < 0) return false;
  plane.constant = -curtain.pos[k * 3 + 2];
  curtain.startGrab(k);
  touched = true;
  curtain.nudge = 0;
  return true;
}

canvas.addEventListener('pointerdown', (e) => {
  if (drag) return;
  if (!grabAt(e.clientX, e.clientY)) return;
  const start = new THREE.Vector3();
  if (!worldAt(e.clientX, e.clientY, start)) {
    curtain.release();
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  drag = { id: e.pointerId, start };
  canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!worldAt(e.clientX, e.clientY, hit)) return;
  const [x, y] = rubber(hit.x - drag.start.x, hit.y - drag.start.y);
  curtain.setGrab(x, y);
});
const end = (e: PointerEvent) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  curtain.release();
  canvas.style.cursor = 'grab';
};
canvas.addEventListener('pointerup', end);
canvas.addEventListener('pointercancel', end);
canvas.style.cursor = 'grab';

// ── simulation ──
let time = 0;
let wave = 0;
let lastDY = 0;
let pullVY = 0;
let idleT = 0;

const ctx = {
  time: 0,
  wave: 0,
  curtain: null as unknown as Curtain,
  exposed: (x: number, y: number, z: number) => {
    // where would this point land on the linen, seen from the camera?
    const k = (CAM_Z - zCloth) / (CAM_Z - z);
    const hz = curtain.hf.sample(x * k, y * k);
    return Number.isNaN(hz) || z > hz + 0.005;
  },
};

function simulate(dt: number) {
  time += dt;
  const gdy = curtain.grabbing ? curtain.grabDY : 0;
  pullVY += ((gdy - lastDY) / dt - pullVY) * (1 - Math.exp(-dt / 0.06));
  lastDY = gdy;

  if (!touched) {
    idleT += dt;
    const ph = (idleT - 2.2) % 6.5;
    curtain.nudge = idleT > 2.2 && ph < 1.8 ? Math.sin((ph / 1.8) * Math.PI) ** 2 : 0;
  }

  curtain.step(dt);
  curtain.updateHeightfield();
  const open = curtain.openness();
  maxOpen = Math.max(maxOpen, Math.min(1, open));
  const speed = clamp(-pullVY / (viewAt(zCloth).H * 1.1), 0, 1);
  wave = Math.max(wave * Math.exp(-dt / 0.9), speed);

  ctx.time = time;
  ctx.wave = wave;
  ctx.curtain = curtain;
  tree.update(dt, ctx);
  curtain.updateMesh();
}

function draw() {
  // 1. silhouette of the tree, as the light behind the linen would cast it
  silCam.copy(camera);
  silCam.layers.set(1);
  scene.overrideMaterial = silMat;
  scene.background = WHITE;
  renderer.setRenderTarget(silRT);
  renderer.render(scene, silCam);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = null;
  scene.background = BG;
  // 2. the room
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
}

let last = performance.now();
let frameAvg = 16;
let frames = 0;
let paused = false;
function frame(now: number) {
  requestAnimationFrame(frame);
  if (paused) {
    last = now;
    return;
  }
  const raw = now - last;
  last = now;
  frameAvg += (raw - frameAvg) * 0.05;
  if (++frames > 90 && frameAvg > 24 && dpr > 1) {
    dpr = Math.max(1, dpr - 0.25);
    renderer.setPixelRatio(dpr);
    size();
    frames = 0;
  }
  simulate(Math.max(Math.min(raw / 1000, 1 / 30), 1 / 240));
  draw();
}
requestAnimationFrame(frame);
document.addEventListener('visibilitychange', () => {
  paused = document.hidden;
});
requestAnimationFrame(() => document.getElementById('fade')?.classList.add('gone'));

// ── test hooks ──
const api = {
  get curtain() {
    return curtain;
  },
  get tree() {
    return tree;
  },
  camera,
  renderer,
  linenU,
  state: () => ({ open: curtain.openness(), maxOpen, wave, dpr, frameAvg, ...tree.stats() }),
  step(ms: number, fps = 60) {
    const n = Math.round((ms / 1000) * fps);
    for (let i = 0; i < n; i++) simulate(1 / fps);
    draw();
  },
  profile(n = 120) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) simulate(1 / 60);
    return (performance.now() - t0) / n;
  },
  /** grab at a screen point given as fractions of the viewport */
  grab(fx = 0.5, fy = 0.6) {
    return grabAt(fx * innerWidth, fy * innerHeight);
  },
  /** pull by fractions of the view height (negative = down) */
  pull(fx: number, fy: number) {
    const v = viewAt(zCloth);
    const [x, y] = rubber(fx * v.H, fy * v.H);
    curtain.setGrab(x, y);
  },
  release() {
    curtain.release();
  },
};
(window as unknown as { __almond: typeof api }).__almond = api;

if (params.has('state')) {
  const s = params.get('state');
  touched = true;
  if (s === 'half' || s === 'full') {
    api.grab(0.5, 0.62);
    const dy = s === 'half' ? -0.3 : -0.7;
    let t0 = 0;
    const tick = () => {
      t0 += 1 / 60;
      api.pull(0, dy * Math.min(1, t0 / 1.6));
      if (t0 < 3) requestAnimationFrame(tick);
      else api.release();
    };
    tick();
  }
}
