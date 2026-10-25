// Seeing each other: where this player's Link is and what he looks like right
// now, and the other players' Links to draw (web/site/ghosts.js draws them).
//
// Everything here reads A Link to the Past's own work RAM, which is the same
// in zelda3 and on a real SNES (randomizers keep it too). Only the video
// memory comes from the backend, as `backend.video`:
//   video.vram(word)   VRAM word, 0-0x7FFF
//   video.cgram(i)     CGRAM color i (15-bit BGR), 0-255
//   video.objBase(t)   word address of sprite tile table t (0 or 1), from OBSEL
//   video.objSizes()   [small, large] sprite sizes in pixels, from OBSEL
//
// Link's picture is sent as a small image (a "pose") the first time it shows
// up; after that only its id travels with his position.

const r16 = (ram, a) => ram.get(a) | (ram.get(a + 1) << 8);
const s8 = (v) => ((v & 0xff) ^ 0x80) - 0x80;

// Modules with Link walking around: dungeon (incl. houses and caves),
// overworld, special overworld (e.g. Master Sword grove).
const PLAY_MODULES = new Set([0x07, 0x09, 0x0B]);

// Where this player is, in coordinates another player's camera can use.
// loc: which map the coordinates belong to. All rooms indoors share one
// coordinate space (a room's position comes from its number), as do the
// light and dark world maps; special overworld areas have their own.
export function readView(ram) {
  if (!PLAY_MODULES.has(ram.get(0x10))) return null;
  const inidisp = ram.get(0x13);           // screen brightness, bit 7 = blank
  if (inidisp & 0x80) return null;
  let loc;
  if (ram.get(0x1B)) loc = 'u';
  else {
    const area = ram.get(0x8A);
    loc = area >= 0x80 ? 'o' + area.toString(16) : area & 0x40 ? 'dw' : 'lw';
  }
  return {
    loc,
    x: r16(ram, 0x22), y: r16(ram, 0x20),           // Link
    camX: r16(ram, 0xE2), camY: r16(ram, 0xE8),     // BG2 scroll = camera
    bright: (inidisp & 0x0f) / 15,
  };
}

// Link's sprites this frame (body, head, sword, shield, shadow...) drawn into
// one image. Returns { ox, oy, w, h, c, p } where (ox, oy) is the image's top
// left relative to Link's position, c the 15-bit colors and p the pixels as
// base64, one byte each: 0 transparent, n = c[n - 1]. Null if nothing shows.
export function captureLink(ram, video) {
  const view = readView(ram);
  if (!view) return null;
  // The game puts Link in 12 OAM slots starting at sort_sprites_offset / 4.
  const first = Math.min(r16(ram, 0x352) >> 2, 128 - 12);
  const sx = (view.x - view.camX) << 16 >> 16;  // Link on screen
  const sy = (view.y - view.camY) << 16 >> 16;
  const sizes = video.objSizes();
  const parts = [];
  for (let i = first + 11; i >= first; i--) {   // lower slots draw on top
    const a = 0x800 + i * 4;
    const y = ram.get(a + 1);
    if (y === 0xf0) continue;                    // unused slot
    const ext = (ram.get(0xA20 + i) & 3);
    let x = ram.get(a) | ((ext & 1) << 8);
    if (x >= 256) x -= 512;
    const dx = x - sx, dy = s8(y - sy);
    if (dx < -48 || dx > 48) continue;           // hidden or not Link's
    parts.push({ dx, dy, size: sizes[ext >> 1], tile: ram.get(a + 2), attr: ram.get(a + 3) });
  }
  if (!parts.length) return null;
  const ox = Math.min(...parts.map((q) => q.dx)), oy = Math.min(...parts.map((q) => q.dy));
  const w = Math.max(...parts.map((q) => q.dx + q.size)) - ox;
  const h = Math.max(...parts.map((q) => q.dy + q.size)) - oy;
  if (w > 64 || h > 64) return null;
  const px = new Uint8Array(w * h);
  const colors = [], colorIndex = new Map();
  for (const q of parts) {
    const base = video.objBase((q.attr & 1));
    const pal = 0x80 + 16 * ((q.attr >> 1) & 7);
    const fx = q.attr & 0x40, fy = q.attr & 0x80;
    for (let row = 0; row < q.size; row++) {
      const r = fy ? q.size - 1 - row : row;
      for (let col = 0; col < q.size; col++) {
        const c = fx ? q.size - 1 - col : col;
        // Tiles of a big sprite wrap within the 16x16-tile page, like the PPU.
        const tile = ((((q.tile >> 4) + (r >> 3)) & 0xf) << 4) | (((q.tile & 0xf) + (c >> 3)) & 0xf);
        const addr = (base + tile * 16 + (r & 7)) & 0x7fff;
        const lo = video.vram(addr), hi = video.vram((addr + 8) & 0x7fff);
        const bit = 7 - (c & 7);
        // 4bpp planar: planes 0/1 in this word's low/high byte, 2/3 eight words on.
        const v = ((lo >> bit) & 1) | (((lo >> (bit + 8)) & 1) << 1) |
          (((hi >> bit) & 1) << 2) | (((hi >> (bit + 8)) & 1) << 3);
        if (!v) continue;
        const o = (q.dy - oy + row) * w + (q.dx - ox + col);
        const color = video.cgram(pal + v) & 0x7fff;
        let n = colorIndex.get(color);
        if (n === undefined) { colors.push(color); n = colors.length; colorIndex.set(color, n); }
        px[o] = n;   // later parts are higher priority: overwrite
      }
    }
  }
  return { ox, oy, w, h, c: colors, p: toBase64(px) };
}

export function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromBase64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// A short id for a pose (FNV-1a of its contents).
export function poseId(img) {
  const s = `${img.ox},${img.oy},${img.w},${img.h},${img.c.join('.')},${img.p}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// Decides what this player sends: { l, x, y, f } (map, position, pose id),
// with the pose image as `img` the first time each pose is sent, or null when
// Link isn't on screen. Returns undefined when nothing changed.
export class PresenceSender {
  constructor(backend) {
    this.backend = backend;
    this.reset();
  }

  // Someone joined or we reconnected: send everything again.
  reset() {
    this.sent = new Set();
    this.last = undefined;
  }

  next() {
    const { ram, video } = this.backend;
    const view = readView(ram);
    const img = view && captureLink(ram, video);
    let p = null;
    if (img) {
      const f = poseId(img);
      p = { l: view.loc, x: view.x, y: view.y, f };
      const key = `${p.l},${p.x},${p.y},${f}`;
      if (key === this.last) return undefined;
      this.last = key;
      if (!this.sent.has(f)) {
        // Keep the set from growing without bound over a long session.
        if (this.sent.size > 2000) this.sent.clear();
        this.sent.add(f);
        p.img = img;
      }
      return p;
    }
    if (this.last === null) return undefined;
    this.last = null;
    return null;
  }
}

// The other players, as the latest positions they sent, ready to draw.
export class RemotePlayers {
  constructor() {
    this.players = new Map();   // id -> { loc, x, y, from: {x, y}, t, dt, pose }
    this.poses = new Map();     // `${id}:${poseId}` -> image
  }

  onPos(id, p, now = performance.now()) {
    if (!p) { this.players.delete(id); return; }
    if (p.img) this.poses.set(`${id}:${p.f}`, p.img);
    const prev = this.players.get(id);
    const pose = this.poses.get(`${id}:${p.f}`) ?? prev?.pose;
    // Glide from where the ghost is drawn now to the new position over the
    // time between updates, unless it jumped (new map, warp, room change).
    const jump = !prev || prev.loc !== p.l || Math.abs(prev.x - p.x) > 64 || Math.abs(prev.y - p.y) > 64;
    const from = jump ? { x: p.x, y: p.y } : this.position(prev, now);
    const dt = prev ? Math.min(250, Math.max(16, now - prev.t)) : 66;
    this.players.set(id, { loc: p.l, x: p.x, y: p.y, from, t: now, dt, pose });
  }

  position(g, now) {
    const k = Math.min(1, (now - g.t) / g.dt);
    return { x: g.from.x + (g.x - g.from.x) * k, y: g.from.y + (g.y - g.from.y) * k };
  }

  // Players who left the room disappear.
  retain(ids) {
    const keep = new Set(ids);
    for (const id of this.players.keys()) if (!keep.has(id)) this.players.delete(id);
    for (const k of this.poses.keys()) if (!keep.has(Number(k.split(':')[0]))) this.poses.delete(k);
  }

  clear() { this.players.clear(); this.poses.clear(); }

  // Ghosts to draw on a screen showing `view` (see readView): screen position
  // of each image's top left, and the image.
  visible(view, now = performance.now()) {
    const out = [];
    if (!view) return out;
    for (const [id, g] of this.players) {
      if (g.loc !== view.loc || !g.pose) continue;
      const { x, y } = this.position(g, now);
      const sx = Math.round(x - view.camX + g.pose.ox), sy = Math.round(y - view.camY + g.pose.oy);
      if (sx < -64 || sx > 320 || sy < -64 || sy > 288) continue;
      out.push({ id, x: sx, y: sy, pose: g.pose });
    }
    return out;
  }
}
