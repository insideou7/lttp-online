// Shared room objects indoors: pots, blocks, switches, pegs, torches, doors
// and anything else the game changes by redrawing part of the room.
//
// Every player in a dungeon room (or house, or cave) watches the room's
// tilemaps and collision maps. When their game changes them (a pot lifted, a
// switch hit, a door unlocked) they send the changed bytes to the others in
// the room, whose clients write them into their own game and queue the
// redraw the same way the game itself does. Whoever hosts the room's enemies
// (mobs.js) also sends a newcomer every change since they arrived, so the
// room looks the same for everyone.
//
// All of it is A Link to the Past's work RAM, the same on zelda3 and an SNES:
//   $7E2000-$7E5FFF  BG2 and BG1 tilemaps of the room (64x64 tiles each)
//   $7F2000-$7F3FFF  collision attributes per tile, both floors
//   $7EC172          orange/blue crystal switch state
//   $7EF580-$7EF7CF  which pots' hidden items were taken, per room
// and the game's VRAM upload list ($7E1000, $7E0014) to redraw tiles.
import { areaKey } from './mobs.js';

const r16 = (ram, a) => ram.get(a) | (ram.get(a + 1) << 8);

const TILEMAP = { addr: 0x2000, len: 0x4000 };
export const REGIONS = [
  TILEMAP,
  { addr: 0x12000, len: 0x2000 },
  { addr: 0xC172, len: 2 },
  { addr: 0xF580, len: 0x250 },
];
const TOTAL = REGIONS.reduce((n, r) => n + r.len, 0);
export const inRegions = (a) => REGIONS.some((r) => a >= r.addr && a < r.addr + r.len);

const steady = (ram) => ram.get(0x10) === 0x07 && ram.get(0x11) === 0;

// VRAM word address of tilemap word `pos` (0-0x1FFF), as Dungeon_MapVramAddr.
const vramAddr = (pos) => {
  const p = pos * 2;
  return ((p & 0x40) << 4) | ((p & 0x303f) >> 1) | ((p & 0xf80) >> 2);
};

const UPLOAD = 0x1000;          // u16 offset, then entries from $1002
const UPLOAD_END = 0x1100;
const MAX_CHANGES = 0x2000;     // per message, in (address, value) pairs

export class RoomTiles {
  constructor(backend, send) {
    this.ram = backend.ram;
    this.send = send;
    this.reset();
  }

  reset() {
    this.k = null;            // room we have a baseline for
    this.last = null;         // watched bytes as of our last look
    this.changes = new Map(); // address -> value changed since we arrived
    this.pending = null;      // { k, entries } that arrived before we were ready
    this.redraw = new Set();  // tilemap words still to upload
    this.lastN = 0;
  }

  read() {
    const out = new Uint8Array(TOTAL);
    let o = 0;
    for (const r of REGIONS) for (let i = 0; i < r.len; i++) out[o++] = this.ram.get(r.addr + i);
    return out;
  }

  // About 15 times a second. owner: { k, id, n } from the server (mobs.js).
  tick(you, owner) {
    const ram = this.ram;
    const k = areaKey(ram);
    if (!k || k[0] !== 'u') { if (k !== null) this.reset(); return; }
    if (!steady(ram)) return;
    if (k !== this.k) {
      // Just arrived: the room as the game built it is our baseline.
      this.reset();
      this.k = k;
      this.last = this.read();
      if (this.pending?.k === k) this.apply(this.pending.entries);
      this.pending = null;
    }
    // What our own game changed.
    const changed = [];
    let o = 0;
    for (const r of REGIONS) {
      for (let i = 0; i < r.len; i++, o++) {
        const v = ram.get(r.addr + i);
        if (v === this.last[o]) continue;
        this.last[o] = v;
        this.changes.set(r.addr + i, v);
        changed.push(r.addr + i, v);
      }
    }
    const here = owner?.k === k ? owner : null;
    if (changed.length && here?.n > 1) this.sendChanges(k, changed);
    // Someone arrived: the host brings them up to date.
    if (here && here.id === you && here.n > this.lastN && this.changes.size) {
      this.sendChanges(k, [...this.changes].flat(), true);
    }
    this.lastN = here?.n ?? 0;
    this.flushRedraw();
  }

  sendChanges(k, list, full = false) {
    for (let i = 0; i < list.length; i += MAX_CHANGES * 2) {
      this.send({ t: 'tiles', k, c: list.slice(i, i + MAX_CHANGES * 2), ...(full ? { f: 1 } : {}) });
    }
  }

  onTiles(msg) {
    if (msg.k !== this.k || !this.last) {
      // Not in that room yet (still loading it): keep for when we are.
      if (this.pending?.k !== msg.k) this.pending = { k: msg.k, entries: [] };
      this.pending.entries.push(...msg.c);
      return;
    }
    this.apply(msg.c);
  }

  apply(c) {
    const ram = this.ram;
    for (let i = 0; i + 1 < c.length; i += 2) {
      const a = c[i], v = c[i + 1] & 0xff;
      if (!inRegions(a)) continue;
      this.changes.set(a, v);
      this.last[this.offset(a)] = v;
      if (ram.get(a) === v) continue;
      ram.set(a, v);
      if (a >= TILEMAP.addr && a < TILEMAP.addr + TILEMAP.len) this.redraw.add((a - TILEMAP.addr) >> 1);
    }
    this.flushRedraw();
  }

  offset(a) {
    let o = 0;
    for (const r of REGIONS) {
      if (a >= r.addr && a < r.addr + r.len) return o + a - r.addr;
      o += r.len;
    }
    return -1;
  }

  // Queue changed tiles for upload to VRAM, as the game's Dungeon_Store2x2
  // does: entries of (VRAM address, length 2, tile), ended by $FF. What
  // doesn't fit this frame goes next time.
  flushRedraw() {
    const ram = this.ram;
    if (!this.redraw.size || !steady(ram)) return;
    const busy = ram.get(0x14);
    if (busy && busy !== 1) return;
    let off = busy ? r16(ram, UPLOAD) : 0;
    let p = UPLOAD + 2 + off;
    for (const pos of this.redraw) {
      if (p + 6 + 1 > UPLOAD_END) break;
      const va = vramAddr(pos), tile = r16(ram, TILEMAP.addr + pos * 2);
      ram.set(p, va >> 8); ram.set(p + 1, va & 0xff);   // big-endian address
      ram.set(p + 2, 0x00); ram.set(p + 3, 0x01);       // 2 bytes, increment 1
      ram.set(p + 4, tile & 0xff); ram.set(p + 5, tile >> 8);
      p += 6;
      this.redraw.delete(pos);
    }
    ram.set(p, 0xff);
    off = p - UPLOAD - 2;
    ram.set(UPLOAD, off & 0xff); ram.set(UPLOAD + 1, off >> 8);
    ram.set(0x14, 1);
  }
}
