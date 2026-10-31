import * as THREE from 'three';
import { Cloth } from './cloth';
import { Blossoms } from './blossoms';
import { wallTextures, linenTextures, petalTexture } from './textures';
import { clamp } from './util';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const coarse = matchMedia('(pointer: coarse)').matches;
const small = Math.min(innerWidth, innerHeight) < 640;
const lowTier = coarse || small;

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

const scene = new THREE.Scene();
scene.background = new THREE.Color('#9fd0d4');
const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 60);

// ── lights: warm low sun from upper left, turquoise sky fill ──
const hemi = new THREE.HemisphereLight('#e8f6f6', '#c9bba0', 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff5e8', 3.1);
sun.position.set(-2.4, 3.4, 4.2);
sun.castShadow = true;
const sm = lowTier ? 1024 : 2048;
sun.shadow.mapSize.set(sm, sm);
sun.shadow.camera.left = -2.4;
sun.shadow.camera.right = 2.4;
sun.shadow.camera.top = 2.4;
sun.shadow.camera.bottom = -2.4;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 12;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.012;
sun.shadow.radius = 4;
scene.add(sun);

const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

// ── wall ──
const wt = wallTextures(aniso, lowTier ? 768 : 1024);
wt.map.repeat.set(3, 3);
wt.bump.repeat.set(3, 3);
const wall = new THREE.Mesh(
  new THREE.PlaneGeometry(16, 16),
  new THREE.MeshStandardMaterial({ map: wt.map, bumpMap: wt.bump, bumpScale: 0.3, roughness: 0.94 }),
);
wall.receiveShadow = true;
scene.add(wall);

// ── linen ──
const lt = linenTextures(aniso);
lt.map.repeat.set(2.6, 3);
lt.normal.repeat.set(2.6, 3);
const linen = new THREE.MeshPhysicalMaterial({
  map: lt.map,
  normalMap: lt.normal,
  normalScale: new THREE.Vector2(0.28, 0.28),
  roughness: 0.9,
  sheen: 0.7,
  sheenRoughness: 0.75,
  sheenColor: new THREE.Color('#fff4e2'),
  side: THREE.DoubleSide,
});
linen.onBeforeCompile = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace(
    '#include <color_fragment>',
    '#include <color_fragment>\n if (!gl_FrontFacing) diffuseColor.rgb *= vec3(0.78, 0.74, 0.70);',
  );
};
const cloth = lowTier ? new Cloth(linen, 24, 29) : new Cloth(linen);
if (lowTier) cloth.iterations = 14;
scene.add(cloth.mesh);

// back of the pouch, seen through the mouth; darker toward the bottom
{
  const g = new THREE.PlaneGeometry(cloth.pinX * 2 - 0.05, cloth.H * 0.96, 1, 12);
  const pos = g.getAttribute('position');
  const col: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) + (cloth.H * 0.96) / 2) / (cloth.H * 0.96);
    const v = 0.28 + 0.44 * Math.pow(t, 1.8);
    col.push(v, v * 0.97, v * 0.93);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const back = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: lt.map, vertexColors: true, roughness: 0.95 }));
  back.position.set(0, cloth.top - (cloth.H * 0.96) / 2, 0.005);
  back.receiveShadow = true;
  scene.add(back);
}

// two brass nails
{
  const brass = new THREE.MeshStandardMaterial({ color: '#b2894a', metalness: 0.55, roughness: 0.38 });
  const head = new THREE.CylinderGeometry(0.02, 0.022, 0.012, 20).rotateX(Math.PI / 2);
  const dome = new THREE.SphereGeometry(0.02, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2).scale(1, 1, 0.35);
  for (const s of [-1, 1]) {
    const g = new THREE.Group();
    const h = new THREE.Mesh(head, brass);
    const d = new THREE.Mesh(dome, brass);
    d.position.z = 0.006;
    g.add(h, d);
    g.position.set(s * cloth.pinX, cloth.top + 0.006, 0.042);
    g.traverse((o) => (o.castShadow = true));
    scene.add(g);
  }
}

// ── blossoms ──
const blossoms = new Blossoms(petalTexture());
scene.add(blossoms.group);

// ── framing ──
function fit() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const portrait = camera.aspect < 0.8;
  const hw = portrait ? 1.16 : 1.36, hh = 1.62, cy = portrait ? 0.16 : 0.08;
  const dist = Math.max(hh / t, hw / (t * camera.aspect));
  camera.position.set(0, cy + 0.08, dist);
  camera.lookAt(0, cy, 0);
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
fit();
addEventListener('resize', fit);

// ── input ──
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const hit = new THREE.Vector3();
let drag: { id: number; start: THREE.Vector3 } | null = null;
let touched = false;
let effDX = 0, effDY = 0;

function worldAt(x: number, y: number, out: THREE.Vector3) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.ray.intersectPlane(plane, out);
}
function rubber(dx: number, dy: number) {
  const x = 0.32 * Math.tanh(dx / 0.32);
  const y = dy < 0 ? -0.62 * Math.tanh(-dy / 0.62) : 0.18 * Math.tanh(dy / 0.18);
  return [x, y];
}

canvas.addEventListener('pointerdown', (e) => {
  if (drag) return;
  const k = cloth.pick(camera, e.clientX, e.clientY, innerWidth, innerHeight, coarse ? 70 : 46);
  if (k < 0) return;
  plane.constant = -cloth.pos[k * 3 + 2];
  const start = new THREE.Vector3();
  if (!worldAt(e.clientX, e.clientY, start)) return;
  canvas.setPointerCapture(e.pointerId);
  drag = { id: e.pointerId, start };
  cloth.startGrab(k);
  touched = true;
  cloth.nudge = 0;
  canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    if (e.pointerType === 'mouse') {
      const k = cloth.pick(camera, e.clientX, e.clientY, innerWidth, innerHeight, 46);
      canvas.style.cursor = k >= 0 ? 'grab' : 'default';
    }
    return;
  }
  if (e.pointerId !== drag.id) return;
  if (!worldAt(e.clientX, e.clientY, hit)) return;
  [effDX, effDY] = rubber(hit.x - drag.start.x, hit.y - drag.start.y);
  cloth.setGrab(effDX, effDY);
});
const end = (e: PointerEvent) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  cloth.release();
  effDX = effDY = 0;
  canvas.style.cursor = 'grab';
};
canvas.addEventListener('pointerup', end);
canvas.addEventListener('pointercancel', end);

// ── loop ──
let time = 0;
let maxOpen = 0;
let lastOpen = 0;
let openVel = 0;
let wave = 0;
let lastDX = 0, lastDY = 0;
let pullVX = 0, pullVY = 0;
let frameAvg = 16;
let frames = 0;
let paused = false;
let idleT = 0;

const ctx = {
  time: 0,
  maxOpen: 0,
  openVel: 0,
  wave: 0,
  pullVX: 0,
  lipY: (x: number) => cloth.lipY(x),
  clothZ: (x: number, y: number) => cloth.hf.sample(x, y),
  disp: (x: number, y: number, o: THREE.Vector3) => cloth.disp(x, y, o),
};

function simulate(dt: number) {
  time += dt;
  // pointer velocity (of the eased grab target)
  const gdx = cloth.grabbing ? cloth.grabDX : lastDX;
  const gdy = cloth.grabbing ? cloth.grabDY : lastDY;
  const k = 1 - Math.exp(-dt / 0.06);
  pullVX += ((gdx - lastDX) / dt - pullVX) * k;
  pullVY += ((gdy - lastDY) / dt - pullVY) * k;
  lastDX = gdx;
  lastDY = gdy;

  // idle hint: a soft tug every few seconds until the first touch
  if (!touched) {
    idleT += dt;
    const ph = (idleT - 2.2) % 5.2;
    cloth.nudge = idleT > 2.2 && ph < 1.4 ? Math.sin((ph / 1.4) * Math.PI) ** 2 : 0;
  }

  cloth.step(dt);
  cloth.updateHeightfield();
  const open = cloth.openness();
  openVel += ((open - lastOpen) / dt - openVel) * (1 - Math.exp(-dt / 0.05));
  lastOpen = open;
  if (cloth.grabbing) maxOpen = Math.max(maxOpen, Math.min(1, open));
  cloth.retainedTarget = maxOpen;

  const speed = clamp(-pullVY / 2.4, 0, 1);
  wave = Math.max(wave * Math.exp(-dt / 0.9), speed * (open > 0.1 ? 1 : 0.3));

  ctx.time = time;
  ctx.maxOpen = maxOpen;
  ctx.openVel = openVel;
  ctx.wave = wave;
  ctx.pullVX = pullVX;
  blossoms.update(dt, ctx);
  cloth.setStems((cb) => blossoms.forInside(cb));
  cloth.updateMesh();
}

let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  if (paused) {
    last = now;
    return;
  }
  const raw = now - last;
  last = now;
  const dt = Math.min(raw / 1000, 1 / 30);
  // adaptive resolution, adjusted before this frame is drawn
  frameAvg += (raw - frameAvg) * 0.05;
  if (++frames > 90 && frameAvg > 24 && dpr > 1) {
    dpr = Math.max(1, dpr - 0.25);
    renderer.setPixelRatio(dpr);
    renderer.setSize(innerWidth, innerHeight, false);
    frames = 0;
  }
  simulate(Math.max(dt, 1 / 240));
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
document.addEventListener('visibilitychange', () => {
  paused = document.hidden;
});
requestAnimationFrame(() => document.getElementById('fade')?.classList.add('gone'));

// ── test hooks ──
const api = {
  cloth,
  blossoms,
  camera,
  renderer,
  state: () => ({ open: cloth.openness(), maxOpen, wave, dpr, frameAvg, ...blossoms.stats() }),
  /** advance the simulation by ms (works with a frozen rAF) and draw */
  /** average ms spent in the simulation (no render) over n frames */
  profile(n = 120) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) simulate(1 / 60);
    return (performance.now() - t0) / n;
  },
  step(ms: number, fps = 60) {
    const n = Math.round((ms / 1000) * fps);
    for (let i = 0; i < n; i++) simulate(1 / fps);
    renderer.render(scene, camera);
  },
  /** grab the hem area at grid (i,j) */
  grab(fi = 0.5, fj = 0.84) {
    touched = true;
    cloth.nudge = 0;
    cloth.startGrab(Math.round(fj * (cloth.rows - 1)) * cloth.cols + Math.round(fi * (cloth.cols - 1)));
  },
  pull(dx: number, dy: number) {
    const [x, y] = rubber(dx, dy);
    cloth.setGrab(x, y);
  },
  release() {
    cloth.release();
  },
};
(window as unknown as { __almond: typeof api }).__almond = api;

if (params.has('state')) {
  const s = params.get('state');
  touched = true;
  if (s === 'half' || s === 'full') {
    api.grab();
    const dy = s === 'half' ? -0.38 : -1.2;
    let t0 = 0;
    const tick = () => {
      t0 += 1 / 60;
      api.pull(0, dy * Math.min(1, t0 / 1.6));
      if (t0 < 3.2) requestAnimationFrame(tick);
      else if (s === 'full') api.release();
    };
    tick();
  }
}
