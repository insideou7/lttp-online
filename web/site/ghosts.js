// Draws the other players' Links over the game picture, with their names.
// A canvas laid over the game canvas, redrawn every animation frame from
// SyncClient.remote and this player's camera (presence.js readView).
import { readView, fromBase64 } from './sync/presence.js';

const SCALE = 3;               // overlay pixels per SNES pixel (crisp names)
const W = 256, H = 224;
const ALPHA = 0.8;             // a little see-through: they're not really there

export function startGhosts({ gameCanvas, sync, backend }) {
  const overlay = document.createElement('canvas');
  overlay.className = 'ghosts';
  overlay.width = W * SCALE;
  overlay.height = H * SCALE;
  gameCanvas.after(overlay);
  const ctx = overlay.getContext('2d');
  const images = new WeakMap();   // pose -> canvas
  const nameOf = (id) => sync.players.find((p) => p.id === id)?.name ?? '';

  function imageFor(pose) {
    let c = images.get(pose);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = pose.w; c.height = pose.h;
    const g = c.getContext('2d');
    const data = g.createImageData(pose.w, pose.h);
    const px = fromBase64(pose.p);
    for (let i = 0; i < px.length; i++) {
      if (!px[i]) continue;
      const col = pose.c[px[i] - 1] ?? 0;   // 15-bit BGR -> 8-bit RGB
      const r = col & 31, gr = (col >> 5) & 31, b = (col >> 10) & 31;
      data.data.set([r << 3 | r >> 2, gr << 3 | gr >> 2, b << 3 | b >> 2, 255], i * 4);
    }
    g.putImageData(data, 0, 0);
    images.set(pose, c);
    return c;
  }

  function frame() {
    requestAnimationFrame(frame);
    // Follow the game canvas, which CSS scales (and moves in full screen).
    const style = overlay.style;
    const left = gameCanvas.offsetLeft + 'px', top = gameCanvas.offsetTop + 'px';
    const width = gameCanvas.offsetWidth + 'px', height = gameCanvas.offsetHeight + 'px';
    if (style.left !== left) style.left = left;
    if (style.top !== top) style.top = top;
    if (style.width !== width) style.width = width;
    if (style.height !== height) style.height = height;

    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const view = backend.inGame() ? readView(backend.ram) : null;
    const ghosts = sync.remote.visible(view);
    if (!ghosts.length) return;
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = ALPHA * view.bright;
    for (const g of ghosts) {
      ctx.drawImage(imageFor(g.pose), g.x * SCALE, g.y * SCALE, g.pose.w * SCALE, g.pose.h * SCALE);
    }
    ctx.font = `bold ${7 * SCALE}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = SCALE;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.fillStyle = '#fff';
    for (const g of ghosts) {
      const name = nameOf(g.id);
      if (!name) continue;
      const x = (g.x + g.pose.w / 2) * SCALE, y = Math.max(8, g.y - 1) * SCALE;
      ctx.strokeText(name, x, y);
      ctx.fillText(name, x, y);
    }
  }
  requestAnimationFrame(frame);
}
