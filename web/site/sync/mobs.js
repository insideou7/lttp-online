// Shared enemies: everyone in the same dungeon room or overworld area sees the
// same monsters, and a hit from anyone counts.
//
// The server makes one player in each area the owner (the first to arrive).
// The owner's game runs the enemies as usual and sends their state about 15
// times a second. The others write that state into their own game between
// frames, so they see and fight the same enemies. When a non-owner hits an
// enemy (or picks up a drop), their game notices first: they send that
// enemy's slot to the owner, who takes it over, and keep their own copy of it
// for a moment so the hit doesn't flicker back.
//
// Everything here is A Link to the Past's work RAM ($7E0000 + addr): the 16
// sprite slots and 8 overlords (enemy spawners). It's the same in zelda3 and
// on a real SNES, randomizers included.
import { toBase64, fromBase64 } from './presence.js';

const r16 = (ram, a) => ram.get(a) | (ram.get(a + 1) << 8);

// Start of each 16-byte sprite table (one byte per slot). From zelda3's
// variables.h: everything from $0B58 to $0F90, plus five tables at $7FF9xx.
export const SPRITE_TABLES = [
  0xB58, 0xB6B, 0xB89, 0xBA0, 0xBB0, 0xBC0, 0xBE0, 0xC9A, 0xCAA, 0xCBA, 0xCD2, 0xCE2,
  0xD00, 0xD10, 0xD20, 0xD30, 0xD40, 0xD50, 0xD60, 0xD70, 0xD80, 0xD90, 0xDA0, 0xDB0,
  0xDC0, 0xDD0, 0xDE0, 0xDF0, 0xE00, 0xE10, 0xE20, 0xE30, 0xE40, 0xE50, 0xE60, 0xE70,
  0xE80, 0xE90, 0xEA0, 0xEB0, 0xEC0, 0xED0, 0xEE0, 0xEF0, 0xF00, 0xF10, 0xF20, 0xF30,
  0xF40, 0xF50, 0xF60, 0xF70, 0xF80, 0xF90,
  0x1F9C2, 0x1FA1C, 0x1FA2C, 0x1FA3C, 0x1FA4C,
];
// Overlords: 8 slots, nine 8-byte tables from $0B00.
const OVERLORD_TABLES = [0xB00, 0xB08, 0xB10, 0xB18, 0xB20, 0xB28, 0xB30, 0xB38, 0xB40];
export const SNAPSHOT_SIZE = SPRITE_TABLES.length * 16 + OVERLORD_TABLES.length * 8;

const STATE = 0xDD0, TYPE = 0xE20, HEALTH = 0xE50, HIT_TIMER = 0xEF0, STUN = 0xB58;
const S_DYING = 0x06, S_CARRIED = 0x0A, S_STUNNED = 0x0B;
// Things Link collects (rupees, hearts, bombs, arrows, magic, keys, fairies,
// heart containers and pieces): picking one up empties its slot.
const PICKUPS = new Set([...Array(16)].map((_, i) => 0xD8 + i).concat([0xEA, 0xEB]));

const LEASE_MS = 400;

// Which enemies this player's game is running: a dungeon room, or a 512x512
// block of an overworld area (big areas have four; enemies far from a
// player's camera stop, so each block gets its own owner). Null outside play.
const PLAY_MODULES = new Set([0x07, 0x09, 0x0B]);
export function areaKey(ram) {
  if (!PLAY_MODULES.has(ram.get(0x10))) return null;
  if (ram.get(0x1B)) return 'u' + r16(ram, 0xA0).toString(16);
  const q = ((r16(ram, 0x22) >> 9) & 1) | (((r16(ram, 0x20) >> 9) & 1) << 1);
  return 'o' + ram.get(0x8A).toString(16) + 'q' + q;
}

// Plain play with no transition, menu or dialog: safe to copy enemies.
const steady = (ram) => PLAY_MODULES.has(ram.get(0x10)) && ram.get(0x11) === 0;

export function readSnapshot(ram) {
  const out = new Uint8Array(SNAPSHOT_SIZE);
  let o = 0;
  for (const t of SPRITE_TABLES) for (let i = 0; i < 16; i++) out[o++] = ram.get(t + i);
  for (const t of OVERLORD_TABLES) for (let i = 0; i < 8; i++) out[o++] = ram.get(t + i);
  return out;
}

export function writeSnapshot(ram, bytes, keep = new Set()) {
  let o = 0;
  for (const t of SPRITE_TABLES) {
    for (let i = 0; i < 16; i++, o++) if (!keep.has(i)) ram.set(t + i, bytes[o]);
  }
  for (const t of OVERLORD_TABLES) for (let i = 0; i < 8; i++) ram.set(t + i, bytes[o++]);
}

// One sprite slot across all tables.
export function readSlot(ram, s) { return Uint8Array.from(SPRITE_TABLES, (t) => ram.get(t + s)); }
export function writeSlot(ram, s, bytes) { SPRITE_TABLES.forEach((t, j) => ram.set(t + s, bytes[j])); }
const slotIn = (snap, table, s) => snap[SPRITE_TABLES.indexOf(table) * 16 + s];

// Is a sprite at (x, y) right next to this player's Link?
const nearLink = (ram, x, y, d) => Math.abs(x - r16(ram, 0x22)) < d && Math.abs(y - r16(ram, 0x20)) < d + 8;
const slotX = (get, s) => get(0xD10, s) | (get(0xD30, s) << 8);
const slotY = (get, s) => get(0xD00, s) | (get(0xD20, s) << 8);

// What did this player's game do to slot s since we wrote `before`?
// 'hit': damaged, stunned, killed or picked up one of the owner's sprites.
// 'new': made a sprite there itself, next to Link (an item from a pot or
// bush, a thrown pot), or threw something it was carrying.
// Otherwise null (including the game dropping sprites it thinks are off screen).
function touched(ram, before, s) {
  const was = slotIn(before, STATE, s);
  const cur = ram.get(STATE + s);
  const sameType = ram.get(TYPE + s) === slotIn(before, TYPE, s);
  if (was === S_CARRIED) return cur && cur !== S_CARRIED ? 'new' : null;
  if (!was || !sameType) {
    const now = (t, i) => ram.get(t + i);
    if (!cur || cur === S_CARRIED) return null;
    const x = slotX(now, s), y = slotY(now, s);
    if (!nearLink(ram, x, y, 48)) return null;
    // An enemy's death drop: the owner's game makes its own.
    const old = (t, i) => slotIn(before, t, i);
    for (let j = 0; j < 16; j++) {
      if (old(STATE, j) === S_DYING && Math.abs(slotX(old, j) - x) < 24 && Math.abs(slotY(old, j) - y) < 24) return null;
    }
    return 'new';
  }
  if (cur === S_CARRIED) return null;
  if (ram.get(HEALTH + s) < slotIn(before, HEALTH, s)) return 'hit';
  if (ram.get(HIT_TIMER + s) > slotIn(before, HIT_TIMER, s)) return 'hit';
  if (ram.get(STUN + s) > slotIn(before, STUN, s)) return 'hit';
  if (cur !== was && (cur === S_DYING || cur === S_STUNNED)) return 'hit';
  // A pickup vanished next to Link: he took it. (Elsewhere the game just
  // stopped running it because it's off this player's screen.)
  if (cur !== 0 || !PICKUPS.has(slotIn(before, TYPE, s))) return null;
  const old = (t, i) => slotIn(before, t, i);
  return nearLink(ram, slotX(old, s), slotY(old, s), 32) ? 'hit' : null;
}

export class MobSync {
  constructor(backend, send) {
    this.ram = backend.ram;
    this.send = send;
    this.reset();
  }

  reset() {
    this.at = undefined;       // area we told the server about
    this.owner = null;         // { k, id, n } for our area
    this.written = null;       // snapshot we last wrote (non-owner)
    this.writtenKey = null;
    this.lease = new Map();    // slot -> time until which we keep our own copy
    this.lastSent = '';
  }

  // Called about 15 times a second with our player id.
  tick(you) {
    const k = areaKey(this.ram);
    // Menus and dialogs don't count as leaving: keep the last area.
    const at = k ?? (this.ram.get(0x10) === 0x0E ? this.at ?? null : null);
    if (at !== this.at) {
      this.at = at;
      this.owner = null;
      this.written = null;
      this.lease.clear();
      this.send({ t: 'at', k: at });
    }
    const o = this.owner;
    if (!o || o.k !== k || o.n < 2 || !steady(this.ram)) return;
    if (o.id !== you) { this.reportHits(k, Date.now()); return; }
    const d = toBase64(readSnapshot(this.ram));
    if (d === this.lastSent) return;
    this.lastSent = d;
    this.send({ t: 'mobs', k, d });
  }

  onOwner(msg) {
    if (msg.k !== this.at) return;
    this.owner = { k: msg.k, id: msg.id, n: msg.n };
    this.lastSent = '';
  }

  // Tell the owner about enemies our game hit since we last copied theirs.
  reportHits(k, now) {
    const ram = this.ram;
    if (!this.written || this.writtenKey !== k) return;
    for (let s = 0; s < 16; s++) {
      if ((this.lease.get(s) ?? 0) > now) continue;
      const what = touched(ram, this.written, s);
      if (!what) continue;
      const slot = readSlot(ram, s);
      this.send({ t: 'hit', k, s, d: toBase64(slot), ...(what === 'new' ? { n: 1 } : {}) });
      this.lease.set(s, now + LEASE_MS);
      SPRITE_TABLES.forEach((_, j) => { this.written[j * 16 + s] = slot[j]; });
    }
  }

  // The owner's enemies arrived: report what we hit, then copy the rest.
  onMobs(msg, now = Date.now()) {
    const ram = this.ram;
    if (msg.k !== areaKey(ram) || !steady(ram)) return;
    const snap = fromBase64(msg.d);
    if (snap.length !== SNAPSHOT_SIZE) return;
    this.reportHits(msg.k, now);
    const keep = new Set();
    for (const [s, until] of this.lease) {
      if (until > now) keep.add(s); else this.lease.delete(s);
    }
    for (let s = 0; s < 16; s++) if (ram.get(STATE + s) === S_CARRIED) keep.add(s);
    // Something the owner's Link carries would sit on our Link's head (the
    // game puts carried sprites over its own Link): leave it out. The ghost
    // shows it over theirs, and once thrown it's an ordinary sprite again.
    const state = SPRITE_TABLES.indexOf(STATE) * 16;
    for (let s = 0; s < 16; s++) if (snap[state + s] === S_CARRIED) snap[state + s] = 0;
    writeSnapshot(ram, snap, keep);
    this.written = readSnapshot(ram);
    this.writtenKey = msg.k;
  }

  // Owner: another player hit one of our enemies; their copy of it wins.
  // Or they made a new sprite: it goes in the same slot if that's free.
  onHit(msg) {
    const ram = this.ram;
    if (msg.k !== areaKey(ram) || !steady(ram)) return;
    const slot = fromBase64(msg.d);
    if (slot.length !== SPRITE_TABLES.length || !int(msg.s)) return;
    if (msg.n) {
      let s = msg.s;
      if (ram.get(STATE + s)) s = [...Array(16).keys()].find((i) => !ram.get(STATE + i)) ?? -1;
      if (s >= 0) writeSlot(ram, s, slot);
      return;
    }
    const typeAt = SPRITE_TABLES.indexOf(TYPE);
    if (!ram.get(STATE + msg.s) || ram.get(TYPE + msg.s) !== slot[typeAt]) return;
    writeSlot(ram, msg.s, slot);
  }
}

const int = (s) => Number.isInteger(s) && s >= 0 && s < 16;
