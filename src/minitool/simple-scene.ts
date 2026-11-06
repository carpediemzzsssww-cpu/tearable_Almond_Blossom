// Interactive Canvas 2D fallback for devices without WebGL 2 or repeated GPU loss.
// A separate canvas avoids trying to reuse a WebGL canvas as a 2D context.
export function simpleScene() {
  const canvas = document.createElement('canvas');
  canvas.id = 'simple-canvas';
  document.body.appendChild(canvas);
  const g = canvas.getContext('2d')!;
  let dip = 0, center = .5, finger: number | null = null, origin = 0, held = 0;
  function draw() {
    const w = innerWidth, h = innerHeight;
    g.fillStyle = '#659fa8'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#777d60'; g.lineWidth = 4;
    for (let i = 0; i < 7; i++) {
      const x = i % 2 ? w + 20 : -20, y = h * (.08 + i * .105);
      const tip = w * (.18 + ((i * 37) % 65) / 100);
      g.beginPath(); g.moveTo(x, y + h * .24); g.quadraticCurveTo(w * .5, y, tip, y - 25); g.stroke();
      for (let j = 0; j < 7; j++) {
        const t = j / 7, bx = x + (tip - x) * t, by = y + h * .24 * (1 - t) ** 2;
        for (let k = 0; k < 5; k++) {
          const a = k * Math.PI * .4 + j;
          g.save(); g.translate(bx + Math.cos(a) * 5, by + Math.sin(a) * 5); g.rotate(a);
          g.fillStyle = k % 2 ? '#eee6da' : '#faf4eb'; g.beginPath(); g.ellipse(4, 0, 7, 5, 0, 0, Math.PI * 2); g.fill(); g.restore();
        }
        g.fillStyle = '#b97676'; g.beginPath(); g.arc(bx, by, 2, 0, Math.PI * 2); g.fill();
      }
    }
    const x = center * w, depth = dip * h;
    g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(x * .55, 0, x * .7, depth, x, depth); g.bezierCurveTo(x + (w - x) * .3, depth, x + (w - x) * .45, 0, w, 0); g.lineTo(w, h); g.lineTo(0, h); g.closePath();
    const linen = g.createLinearGradient(0, 0, w, 0); linen.addColorStop(0, '#e9e2d5'); linen.addColorStop(.38, '#faf4e8'); linen.addColorStop(.62, '#e3dacb'); linen.addColorStop(1, '#f4eddf');
    g.fillStyle = linen; g.fill();
    g.save(); g.clip(); g.strokeStyle = 'rgba(134,118,93,.07)'; g.lineWidth = .5;
    for (let n = 0; n < w; n += 3) { g.beginPath(); g.moveTo(n, 0); g.lineTo(n + Math.sin(n) * 2, h); g.stroke(); }
    for (let n = 0; n < h; n += 3) { g.beginPath(); g.moveTo(0, n); g.lineTo(w, n); g.stroke(); }
    g.restore();
  }
  function resize() { canvas.width = innerWidth; canvas.height = innerHeight; draw(); }
  canvas.addEventListener('pointerdown', e => { if (finger !== null) return; finger = e.pointerId; origin = e.clientY; held = dip; center = e.clientX / innerWidth; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => { if (finger !== e.pointerId) return; dip = Math.max(0, Math.min(.95, held + (e.clientY - origin) / innerHeight)); draw(); });
  function release() { finger = null; dip *= .85; draw(); }
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
  addEventListener('blur', release); addEventListener('resize', resize);
  resize();
  return () => { finger = null; dip = 0; center = .5; draw(); };
}
