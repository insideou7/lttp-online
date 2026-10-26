// Shared dialog boxes: when one player's game shows a text box (someone
// talking, a sign, an item found...), the other players in the same room or
// overworld area see it too, drawn over their game (web/site/ghosts.js). It
// never pauses their game: it's only a picture of the other player's box.
//
// The box is copied from video memory exactly as the speaker's game drew it,
// border and letters, so it works for any text: the US game, the Japanese
// one, and randomizers with their own messages. Like presence.js this reads
// only A Link to the Past's work RAM plus `backend.video`, so both backends
// share it.
//
// From zelda3's messaging.c: the text box is the interface module (0x0E),
// submodule 2. $1CD4 is the text renderer's state; 3 means the box is up and
// letters are being drawn or wait for a button. $1CD2 is the VRAM word
// address of the box's top left corner in the BG3 tilemap (32 tiles a row).
// The box is 8 tiles high and 24 wide in the US game; the Japanese game
// (and randomizers built from it) uses the same RAM but a 23-tile box, so
// the width is found from the top right corner, the top left one mirrored.
// BG3 tiles are 2 bits a pixel at VRAM $7000 (the game always sets BG34NBA
// to 7).
import { toBase64, fromBase64 } from './presence.js';
import { areaKey } from './mobs.js';
import { deflate, inflate } from '../bps.js';

const r16 = (ram, a) => ram.get(a) | (ram.get(a + 1) << 8);

export const BOX_W = 24, BOX_H = 8;   // tiles, at most
const BG3_CHR = 0x7000;
const RESEND_MS = 1000;   // repeat an unchanged box, for players who just arrived
const MIN_GAP_MS = 120;   // letters appear quickly; don't send every one
export const EXPIRE_MS = 3000;   // a box nobody repeated is gone

// Where the text box is on screen, in tiles, or null if none is up.
export function readTextBox(ram) {
  if (ram.get(0x10) !== 0x0E || ram.get(0x11) !== 0x02 || ram.get(0x1CD4) !== 3) return null;
  const at = r16(ram, 0x1CD2);
  const col = at & 31, row = (at >> 5) & 31;
  if (col + 16 > 32 || row + BOX_H > 28) return null;
  return { at, col, row };
}

// Width of the box in tiles: up to its top right corner.
function boxWidth(video, box) {
  const corner = video.vram(box.at & 0x7fff) ^ 0x4000;   // flipped horizontally
  for (let w = 16; w <= BOX_W && box.col + w <= 32; w++) {
    if (video.vram((box.at + w - 1) & 0x7fff) === corner) return w;
  }
  return Math.min(BOX_W, 32 - box.col);
}

// The box as bytes: col, row, width and height in tiles, the number of
// colors n, n 15-bit colors (little endian), then one byte a pixel: 0 for
// transparent, i for color i. Null if no box is up.
export function captureTextBox(ram, video) {
  const box = readTextBox(ram);
  if (!box) return null;
  const tw = boxWidth(video, box);
  const w = tw * 8, h = BOX_H * 8;
  const px = new Uint8Array(w * h);
  const colors = [], colorIndex = new Map();
  for (let ty = 0; ty < BOX_H; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const e = video.vram((box.at + ty * 32 + tx) & 0x7fff);
      const tile = e & 0x3ff, pal = (e >> 10) & 7, fx = e & 0x4000, fy = e & 0x8000;
      for (let r = 0; r < 8; r++) {
        const word = video.vram((BG3_CHR + tile * 8 + (fy ? 7 - r : r)) & 0x7fff);
        for (let c = 0; c < 8; c++) {
          const bit = fx ? c : 7 - c;
          const v = ((word >> bit) & 1) | (((word >> (bit + 8)) & 1) << 1);
          if (!v) continue;
          const color = video.cgram(pal * 4 + v) & 0x7fff;
          let n = colorIndex.get(color);
          if (n === undefined) {
            if (colors.length === 255) continue;
            colors.push(color); n = colors.length; colorIndex.set(color, n);
          }
          px[(ty * 8 + r) * w + tx * 8 + c] = n;
        }
      }
    }
  }
  const out = new Uint8Array(5 + colors.length * 2 + px.length);
  out.set([box.col, box.row, tw, BOX_H, colors.length]);
  colors.forEach((c, i) => { out[5 + i * 2] = c & 0xff; out[6 + i * 2] = c >> 8; });
  out.set(px, 5 + colors.length * 2);
  return out;
}

// The bytes captureTextBox made, as { col, row, w, h, c, px } with w and h in
// pixels; null if they don't make sense.
export function decodeTextBox(bytes) {
  if (bytes.length < 5) return null;
  const [col, row, tw, th, n] = bytes;
  const w = tw * 8, h = th * 8;
  if (!tw || !th || col + tw > 32 || row + th > 32 || bytes.length !== 5 + n * 2 + w * h) return null;
  const c = [];
  for (let i = 0; i < n; i++) c.push((bytes[5 + i * 2] | (bytes[6 + i * 2] << 8)) & 0x7fff);
  const px = bytes.subarray(5 + n * 2);
  if (px.some((v) => v > n)) return null;
  return { col, row, w, h, c, px };
}

const sameBytes = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

// This player's side: sends { t: 'dlg', k, d } while a text box is up, d being
// the deflated box (base64), and d: null when it closes. k is the area the
// player was in when the box opened (mobs.js areaKey; it reads null while
// the box is up, since the game is paused).
export class DialogSender {
  constructor(backend, send) {
    this.backend = backend;
    this.send = send;
    this.area = null;     // last area this player played in
    this.last = null;     // bytes last sent
    this.sentAt = -Infinity;
    this.open = null;     // area the open box was sent to
    this.busy = false;
  }

  reset() { this.last = null; this.sentAt = -Infinity; }

  tick(now = performance.now()) {
    const { ram, video } = this.backend;
    if (!video) return;
    const k = areaKey(ram);
    if (k) this.area = k;
    const bytes = k ? null : captureTextBox(ram, video);
    if (!bytes) {
      if (this.open) {
        this.send({ t: 'dlg', k: this.open, d: null });
        this.open = null;
        this.last = null;
      }
      return;
    }
    if (!this.area || this.busy) return;
    const changed = !sameBytes(bytes, this.last);
    if (changed ? now - this.sentAt < MIN_GAP_MS : now - this.sentAt < RESEND_MS) return;
    this.busy = true;
    this.last = bytes;
    this.sentAt = now;
    const area = this.area;
    return deflate(bytes).then((z) => {
      // Closed while compressing: the close was already sent.
      if (!this.last) return;
      this.open = area;
      this.send({ t: 'dlg', k: area, d: toBase64(z) });
    }).catch((e) => console.warn('[sync] dialog box:', e))
      .finally(() => { this.busy = false; });
  }
}

// The other players' boxes, ready to draw: id -> { k, box, t }.
export class RemoteDialogs {
  constructor() {
    this.boxes = new Map();
    this.seq = new Map();   // id -> latest message number, so a slow inflate can't undo a close
  }

  async onDlg(id, k, d, now = () => performance.now()) {
    const n = (this.seq.get(id) ?? 0) + 1;
    this.seq.set(id, n);
    if (!d) { this.boxes.delete(id); return; }
    let box = null;
    try { box = decodeTextBox(await inflate(fromBase64(d))); } catch { /* bad data */ }
    if (this.seq.get(id) !== n) return;
    if (box) this.boxes.set(id, { k, box, t: now() });
  }

  // Boxes of players in this player's area (mobs.js areaKey), oldest first.
  visible(k, now = performance.now()) {
    const out = [];
    if (!k) return out;
    for (const [id, b] of this.boxes) {
      if (now - b.t > EXPIRE_MS) { this.boxes.delete(id); continue; }
      if (b.k === k) out.push({ id, box: b.box, t: b.t });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  retain(ids) {
    const keep = new Set(ids);
    for (const id of this.boxes.keys()) if (!keep.has(id)) this.boxes.delete(id);
  }

  clear() { this.boxes.clear(); }
}
