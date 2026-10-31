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
renderer.toneMappingExposure = 1.18;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;

const BG = new THREE.Color('#659fa8');
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
scene.add(new THREE.HemisphereLight('#e8f1ee', '#c9bfae', 1.85));
const sun = new THREE.DirectionalLight('#fff7eb', 2.15);
sun.position.set(-2.6, 3.6, 4.6);
sun.castShadow = true;
const sm = lowTier ? 1024 : 2048;
sun.shadow.mapSize.set(sm, sm);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 14;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.015;
sun.shadow.intensity = 0.66;
scene.add(sun);

const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

// ── the painting behind: turquoise wall with short strokes ──
const wt = wallTextures(aniso, lowTier ? 768 : 1024);
wt.map.repeat.set(3.4, 3.4);
wt.bump.repeat.set(3.4, 3.4);
const wall = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.MeshStandardMaterial({ map: wt.map, bumpMap: wt.bump, bumpScale: 0.035, roughness: 0.97 }),
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
  uGlow: { value: 0.18 },
  uSize: { value: new THREE.Vector2(1, 1) },
};
const linen = new THREE.MeshPhysicalMaterial({
  map: lt.map,
  normalMap: lt.normal,
  normalScale: new THREE.Vector2(0.16, 0.16),
  roughness: 0.96,
  sheen: 0.38,
  sheenRoughness: 0.9,
  sheenColor: new THREE.Color('#f2eadb'),
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
      // Both faces are the same linen, with a little less light on its reverse.
      if (!gl_FrontFacing) diffuseColor.rgb *= vec3(0.95, 0.94, 0.92);`,
    )
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      // daylight through the weave, interrupted by the branches behind it
      vec2 suv = gl_FragCoord.xy / uRes;
      float sil = texture(tSil, suv + vec2(-0.004, -0.012), 2.2).r * 0.5 + texture(tSil, suv + vec2(-0.009, -0.024), 3.8).r * 0.5;
      float face = gl_FrontFacing ? 1.0 : 0.75;
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
  const tile = vc.H * 0.22;
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
      releasePointer();
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
  // Enough lateral travel to peel a flap sideways; only the far end of a
  // gesture meets the soft limit, so short movements stay close to 1:1.
  const mx = v.W * 0.46, my = v.H * 1.05, up = v.H * 0.25;
  return [mx * Math.tanh(dx / mx), dy < 0 ? -my * Math.tanh(-dy / my) : up * Math.tanh(dy / up)];
}
function grabAt(sx: number, sy: number) {
  ndc.set((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  curtain.mesh.geometry.computeBoundingSphere();
  // A hole is empty space. Projecting every particle alone would let the hand
  // grab invisible cloth through the opening, or a rear fold through the front.
  const surface = ray.intersectObject(curtain.mesh, false)[0];
  if (!surface) return false;
  let k = -1, distance = Infinity;
  if (surface.faceIndex != null) {
    for (const candidate of curtain.surface.physicsVerticesForTriangle(surface.faceIndex)) {
      if (!curtain.isParticleActive(candidate) || curtain.inv[candidate] === 0) continue;
      hit.fromArray(curtain.pos, candidate * 3).project(camera);
      const d = ((hit.x * 0.5 + 0.5) * innerWidth - sx) ** 2 + ((0.5 - hit.y * 0.5) * innerHeight - sy) ** 2;
      if (d < distance) { distance = d; k = candidate; }
    }
  }
  if (k < 0) return false;
  plane.constant = -curtain.pos[k * 3 + 2];
  curtain.startGrab(k);
  touched = true;
  curtain.nudge = 0;
  return true;
}

canvas.addEventListener('pointerdown', (e) => {
  if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (!grabAt(e.clientX, e.clientY)) return;
  const start = new THREE.Vector3();
  if (!worldAt(e.clientX, e.clientY, start)) {
    curtain.release();
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  drag = { id: e.pointerId, start };
  lastDY = 0;
  pullVY = 0;
  canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  // Browsers may batch stylus/touch samples; use their newest position and
  // let the fixed-step cloth solver absorb the motion continuously.
  const samples = e.getCoalescedEvents?.();
  const latest = samples?.length ? samples[samples.length - 1] : e;
  if (!worldAt(latest.clientX, latest.clientY, hit)) return;
  const [x, y] = rubber(hit.x - drag.start.x, hit.y - drag.start.y);
  curtain.setGrab(x, y);
});
function releasePointer() {
  const id = drag?.id;
  drag = null;
  curtain.release();
  if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  canvas.style.cursor = 'grab';
}
const end = (e: PointerEvent) => {
  if (!drag || e.pointerId !== drag.id) return;
  releasePointer();
};
canvas.addEventListener('pointerup', end);
canvas.addEventListener('pointercancel', end);
canvas.addEventListener('lostpointercapture', end);
addEventListener('blur', releasePointer);
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
  const gdy = curtain.grabDY;
  const velocity = curtain.grabbing ? (gdy - lastDY) / dt : 0;
  pullVY += (velocity - pullVY) * (1 - Math.exp(-dt / 0.06));
  lastDY = gdy;

  if (!touched) {
    idleT += dt;
    const ph = (idleT - 2.2) % 6.5;
    curtain.nudge = idleT > 2.2 && ph < 1.8 ? Math.sin((ph / 1.8) * Math.PI) ** 2 : 0;
  }

  curtain.step(dt);
  curtain.updateMesh();
  curtain.updateHeightfield();
  const open = curtain.openness();
  maxOpen = Math.max(maxOpen, Math.min(1, open));
  const speed = clamp(-pullVY / (viewAt(zCloth).H * 1.1), 0, 1);
  wave = Math.max(wave * Math.exp(-dt / 0.9), speed);

  ctx.time = time;
  ctx.wave = wave;
  ctx.curtain = curtain;
  tree.update(dt, ctx);
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
  if (paused) releasePointer();
  last = performance.now();
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
  state: () => ({ open: curtain.openness(), maxOpen, wave, dpr, frameAvg, ...tree.stats(), ...curtain.stats() }),
  reset() {
    releasePointer();
    build();
    time = wave = lastDY = pullVY = idleT = 0;
    touched = false;
  },
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
    lastDY = 0;
    pullVY = 0;
    return grabAt(fx * innerWidth, fy * innerHeight);
  },
  /** pull by fractions of the view height (negative = down) */
  pull(fx: number, fy: number) {
    const v = viewAt(zCloth);
    const [x, y] = rubber(fx * v.H, fy * v.H);
    curtain.setGrab(x, y);
  },
  release() {
    releasePointer();
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
