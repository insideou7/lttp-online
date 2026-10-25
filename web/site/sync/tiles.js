// Shared surroundings: what players change about the place they're in shows
// up for everyone there.
//
// Indoors (dungeons, houses, caves): pots, switches, pegs, doors, torches and
// anything else the game changes by redrawing part of the room. Outdoors:
// bushes, rocks, signs, dug holes, bombed walls, hammered pegs.
//
// Every player watches the tilemap and related state of where they are. When
// their game changes it (a pot lifted, a bush cut, a switch hit) they send the
// changed bytes to the others there, whose clients write them into their own
// game and queue the redraw the same way the game itself does. Whoever hosts
// the area's enemies (mobs.js) also sends a newcomer every change since they
// arrived, so the place looks the same for everyone.
//
// All of it is A Link to the Past's work RAM, the same on zelda3 and an SNES:
// indoors
//   $7E2000-$7E5FFF  BG2 and BG1 tilemaps of the room (64x64 tiles each)
//   $7F2000-$7F3FFF  collision attributes per tile, both floors
//   $7EC172          orange/blue crystal switch state
//   $7EF580-$7EF7CF  which pots' hidden items were taken, per room
// outdoors
//   $7E2000-$7E3FFF  the area's map16 tiles (64x64 16x16 tiles; collision
//                    comes from these too)
//   $7EF800/$7EFA00  the game's list of changed tiles to restore after a
//                    visit indoors ($7E04AC = its length)
// and the game's VRAM upload list ($7E1000, $7E0014) to redraw tiles.
// Outdoor redraws need the ROM's map16-to-tiles table: backend.map16(v)
// returns the four 8x8 tile words of map16 tile v.
import { areaKey } from './mobs.js';

const r16 = (ram, a) => ram.get(a) | (ram.get(a + 1) << 8);

const TILEMAP = 0x2000;
const INDOOR = [
  { addr: 0x2000, len: 0x4000 },
  { addr: 0x12000, len: 0x2000 },
  { addr: 0xC172, len: 2 },
  { addr: 0xF580, len: 0x250 },
];
const OUTDOOR = [{ addr: 0x2000, len: 0x2000 }];
const ALL = INDOOR;   // OUTDOOR is inside it
export const inRegions = (a, regions = ALL) => regions.some((r) => a >= r.addr && a < r.addr + r.len);
const size = (regions) => regions.reduce((n, r) => n + r.len, 0);

// Where we are, for the purpose of shared tiles: { b, indoor, regions }.
// Indoors it's the room; outdoors the whole area (big areas have one map).
function place(ram) {
  const module = ram.get(0x10);
  if (ram.get(0x11) !== 0) return null;
  if (module === 0x07 && ram.get(0x1B)) return { b: 'u' + r16(ram, 0xA0).toString(16), indoor: true, regions: INDOOR };
  if ((module === 0x09 || module === 0x0B) && !ram.get(0x1B)) return { b: 'o' + ram.get(0x8A).toString(16), indoor: false, regions: OUTDOOR };
  return null;
}

// VRAM word address of room tilemap word `pos` (0-0x1FFF), as Dungeon_MapVramAddr.
const roomVram = (pos) => {
  const p = pos * 2;
  return ((p & 0x40) << 4) | ((p & 0x303f) >> 1) | ((p & 0xf80) >> 2);
};
// VRAM word address of overworld map16 byte offset `addr`, as Overworld_FindMap16VRAMAddress.
const map16Vram = (addr) =>
  ((addr & 0x3f) >= 0x20 ? 0x400 : 0) + ((addr & 0xfff) >= 0x800 ? 0x800 : 0) + (addr & 0x1f) + ((addr & 0x780) >> 1);

const UPLOAD = 0x1000;          // u16 offset, then entries from $1002
const UPLOAD_END = 0x1100;
const MAX_CHANGES = 0x2000;     // per message, in (address, value) pairs
const MEMO_COUNT = 0x4AC, MEMO_ADDR = 0xF800, MEMO_VALUE = 0xFA00, MEMO_MAX = 0x100;

export class RoomTiles {
  constructor(backend, send) {
    this.ram = backend.ram;
    this.map16 = backend.map16?.bind(backend);
    this.send = send;
    this.reset();
  }

  reset() {
    this.place = null;        // where we have a baseline for
    this.last = null;         // watched bytes as of our last look
    this.changes = new Map(); // address -> value changed since we arrived
    this.pending = null;      // { b, entries } that arrived before we were ready
    this.redraw = new Set();  // tilemap words still to upload
    this.lastN = 0;
  }

  get b() { return this.place?.b ?? null; }

  read(regions) {
    const out = new Uint8Array(size(regions));
    let o = 0;
    for (const r of regions) for (let i = 0; i < r.len; i++) out[o++] = this.ram.get(r.addr + i);
    return out;
  }

  // About 15 times a second. owner: { k, id, n } from the server (mobs.js).
  tick(you, owner) {
    const ram = this.ram;
    const k = areaKey(ram);
    if (k === null) return;           // not playing, or in a menu
    const p = place(ram);
    if (!p) return;                   // transition, menu or dialog
    if (p.b !== this.b) {
      // Just arrived: the place as the game built it is our baseline.
      const pending = this.pending;
      this.reset();
      this.place = p;
      this.last = this.read(p.regions);
      this.pending = pending?.b === p.b ? pending : null;
    }
    if (this.pending?.b === p.b) {
      const { entries } = this.pending;
      this.pending = null;
      this.apply(entries);
    }
    // What our own game changed.
    const changed = [];
    let o = 0;
    for (const r of p.regions) {
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
      this.send({ t: 'tiles', k, b: this.b, c: list.slice(i, i + MAX_CHANGES * 2), ...(full ? { f: 1 } : {}) });
    }
  }

  onTiles(msg) {
    const b = msg.b ?? msg.k;
    if (b !== this.b || place(this.ram)?.b !== b) {
      // Not there yet (still loading it), or on the way out (the game may
      // already hold the next area's map): keep for when we're there.
      if (this.pending?.b !== b) this.pending = { b, entries: [] };
      this.pending.entries.push(...msg.c);
      return;
    }
    this.apply(msg.c);
  }

  apply(c) {
    const ram = this.ram;
    const { regions, indoor } = this.place;
    const words = new Set();
    for (let i = 0; i + 1 < c.length; i += 2) {
      const a = c[i], v = c[i + 1] & 0xff;
      if (!inRegions(a, regions)) continue;
      this.changes.set(a, v);
      this.last[this.offset(a)] = v;
      if (ram.get(a) === v) continue;
      ram.set(a, v);
      if (a >= TILEMAP && a < TILEMAP + regions[0].len) words.add((a - TILEMAP) >> 1);
    }
    for (const pos of words) {
      this.redraw.add(pos);
      if (!indoor) this.memorize(pos);
    }
    this.flushRedraw();
  }

  // Outdoors the game keeps a list of changed tiles, to put them back after a
  // trip indoors; add the ones from other players to it.
  memorize(pos) {
    const ram = this.ram, value = r16(ram, TILEMAP + pos * 2);
    if (value === 0xdc5 || value === 0xdc9) return;
    const n = r16(ram, MEMO_COUNT);
    if (n >> 1 >= MEMO_MAX) return;
    const w = (a, v) => { ram.set(a, v & 0xff); ram.set(a + 1, v >> 8); };
    w(MEMO_ADDR + n, pos * 2);
    w(MEMO_VALUE + n, value);
    w(MEMO_COUNT, n + 2);
  }

  offset(a) {
    let o = 0;
    for (const r of this.place.regions) {
      if (a >= r.addr && a < r.addr + r.len) return o + a - r.addr;
      o += r.len;
    }
    return -1;
  }

  // Outdoors the screen's tilemap in VRAM holds only what's around the camera,
  // and a tile far away would land on top of something on screen. Draw only
  // what's in view: the game draws the rest from the new map16 tiles as it
  // scrolls there. Returns a test of map16 index pos, or null to draw all.
  viewOf(ram) {
    const area = ram.get(0x8A);
    if (area >= 0x80) return null;
    const ox = (area & 7) << 9, oy = ((area & 0x3f) >> 3) << 9;
    const cx = r16(ram, 0xE2) - ox, cy = r16(ram, 0xE8) - oy;
    return (pos) => {
      const x = (pos & 0x3f) << 4, y = (pos >> 6) << 4;
      return x + 16 > cx - 16 && x < cx + 256 + 16 && y + 16 > cy - 16 && y < cy + 224 + 16;
    };
  }

  // Queue changed tiles for upload to VRAM, as the game does: entries of
  // (VRAM address big-endian, length, tiles), ended by $FF. Indoors one 8x8
  // tile per tilemap word (Dungeon_Store2x2); outdoors two rows of two 8x8
  // tiles per map16 tile (Overworld_DrawMap16). What doesn't fit this frame
  // goes next time.
  flushRedraw() {
    const ram = this.ram;
    if (!this.redraw.size || !place(ram) || place(ram).b !== this.b) return;
    const indoor = this.place.indoor;
    if (!indoor && !this.map16) { this.redraw.clear(); return; }
    const busy = ram.get(0x14);
    if (busy && busy !== 1) return;
    let p = UPLOAD + 2 + (busy ? r16(ram, UPLOAD) : 0);
    const start = p;
    const put = (addr, bytes) => {
      ram.set(p, addr >> 8); ram.set(p + 1, addr & 0xff);
      ram.set(p + 2, 0x00); ram.set(p + 3, bytes - 1);
      p += 4;
    };
    const word = (v) => { ram.set(p, v & 0xff); ram.set(p + 1, (v >> 8) & 0xff); p += 2; };
    const view = indoor ? null : this.viewOf(ram);
    for (const pos of this.redraw) {
      if (view && !view(pos)) { this.redraw.delete(pos); continue; }
      if (p + (indoor ? 6 : 16) + 1 > UPLOAD_END) break;
      const tile = r16(ram, TILEMAP + pos * 2);
      if (indoor) {
        put(roomVram(pos), 2); word(tile);
      } else {
        const t = this.map16(tile), va = map16Vram(pos * 2);
        put(va, 4); word(t[0]); word(t[1]);
        put(va + 0x20, 4); word(t[2]); word(t[3]);
      }
      this.redraw.delete(pos);
    }
    if (p === start) return;
    ram.set(p, 0xff);
    const off = p - UPLOAD - 2;
    ram.set(UPLOAD, off & 0xff); ram.set(UPLOAD + 1, off >> 8);
    ram.set(0x14, 1);
  }
}
