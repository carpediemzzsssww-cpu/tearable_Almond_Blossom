import { start } from './main';
import { simpleScene } from './minitool/simple-scene';
import './minitool/style.css';

type Rect = { top: number; bottom: number; left: number; right: number };
type Info = { windowWidth: number; windowHeight: number; safeArea?: Rect; menuButtons?: Record<string, Rect | null> };
type Bridge = { getWindowInfo?: () => Promise<Info>; getLaunchOptions?: () => Promise<{ miniToolEnv?: { buildVersion?: number } }> };
const host = window as unknown as { xhs?: { miniTool?: Bridge; launchOptions?: { miniToolEnv?: { buildVersion?: number } } }; __almond?: { reset: () => void } };
let simpleReset: (() => void) | undefined;
function fallback() {
  if (simpleReset) return;
  document.body.classList.add('fallback');
  document.body.classList.remove('context-lost');
  simpleReset = simpleScene();
}
// Start after the classic script's DOM has been parsed (including controls).
async function layout() {
  document.documentElement.style.setProperty('--app-height', `${innerHeight}px`);
  const bridge = host.xhs?.miniTool;
  if (!bridge?.getWindowInfo) return;
  try {
    const opts = host.xhs?.launchOptions || await bridge.getLaunchOptions?.();
    const build = opts?.miniToolEnv?.buildVersion || 0;
    if (Math.floor(build / 1000) < 9490) return;
    const info = await bridge.getWindowInfo();
    const sx = innerWidth / (info.windowWidth || innerWidth);
    const sy = innerHeight / (info.windowHeight || innerHeight);
    if (info.safeArea) {
      const left = Math.max(0, info.safeArea.left || 0) * sx + 16;
      const bottom = Math.max(0, info.windowHeight - info.safeArea.bottom) * sy + 16;
      document.documentElement.style.setProperty('--reset-left', `${Math.min(left, innerWidth - 60)}px`);
      document.documentElement.style.setProperty('--reset-bottom', `${Math.min(bottom, innerHeight - 60)}px`);
    }
  } catch { /* Old client / unavailable bridge: retain the safe fallback. */ }
}
function boot() {
  void layout();
  addEventListener('resize', () => { void layout(); });
  document.getElementById('restart')!.addEventListener('click', () => {
    if (simpleReset) simpleReset(); else host.__almond?.reset();
  });
  try { start(fallback); } catch { fallback(); }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
