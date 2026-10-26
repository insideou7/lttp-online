// Which parts of the save area players share, and how two players' values merge.
//
// Addresses are offsets into SNES work RAM ($7E0000), so 0xF340 is $7EF340.
// The table is backend-agnostic: zelda3 and an SNES emulator core (for
// randomizer ROMs, which keep vanilla's item RAM layout) read the same bytes.
//
// Anything not listed here stays per player: rupees, bombs, arrows, current
// health and magic, bottle contents, position, followers.
//
// Merge kinds:
//   bits  bytes whose bits only ever get set (chests opened, pendants...).
//         Merge is bitwise OR.
//   max   a level that only goes up (gloves 1 -> 2). Merge is the maximum.
//   sum   a count where each player's gains add up (heart pieces, capacity
//         upgrades). Ops carry the increase, not the total.
//   set   last writer wins, for items the game can also take away
//         (the smiths borrow your sword, a Like Like eats your shield).
//   counts  per-slot counts that go up and down (small keys per dungeon).
//         Ops carry the change, so a key one player picks up is added for
//         everyone and a key one player uses is spent for everyone.

const u8 = (addr) => ({
  read: (ram) => ram.get(addr),
  write: (ram, v) => ram.set(addr, v),
});
// A 16-bit little-endian value.
const u16 = (addr) => ({
  read: (ram) => ram.get(addr) | (ram.get(addr + 1) << 8),
  write: (ram, v) => { ram.set(addr, v & 0xff); ram.set(addr + 1, (v >> 8) & 0xff); },
});
// Only some bits of a byte; the rest stay the player's own.
const someBits = (addr, mask) => ({
  kind: 'bits', len: 1,
  read: (ram) => [ram.get(addr) & mask],
  write: (ram, [m]) => ram.set(addr, (ram.get(addr) & ~mask & 0xff) | (m & mask)),
});

// Index into the per-dungeon key counts of the dungeon Link is in, or -1.
// $7E040C is the dungeon number times two, 0xFF outside dungeons.
function curDungeon(ram) {
  const x2 = ram.get(0x40C);
  if (x2 === 0xFF) return -1;
  return (x2 === 2 ? 0 : x2) >> 1;
}

const item = (key, addr, label, extra = {}) => ({ key, kind: 'max', ...u8(addr), label, refresh: 'hud', ...extra });

export const FIELDS = [
  // Per-room dungeon flags: chests, keys, doors, bosses, visited quadrants.
  { key: 'rooms', kind: 'bits', addr: 0xF000, len: 0x250 },
  // Overworld area flags: heart pieces taken, bombed walls, opened entrances.
  { key: 'overworld', kind: 'bits', addr: 0xF280, len: 0x80 },
  { key: 'masterSwordFlags', kind: 'bits', addr: 0xF300, len: 2 },

  // Bow: $7EF340 is 1 bow, 2 bow+arrows, 3 silver bow, 4 silver bow+arrows.
  // The "+arrows" half depends on the player's own arrow count, so only the
  // tier is shared.
  {
    key: 'bow', kind: 'max', label: ['', 'Bow', 'Silver Arrows'], refresh: 'hud',
    read: (ram) => { const v = ram.get(0xF340); return v >= 3 ? 2 : v >= 1 ? 1 : 0; },
    write: (ram, tier) => {
      if (!tier) return ram.set(0xF340, 0);
      const arrows = ram.get(0xF377) > 0 ? 1 : 0;
      ram.set(0xF340, (tier === 2 ? 3 : 1) + arrows);
    },
  },
  item('boomerang', 0xF341, ['', 'Boomerang', 'Magical Boomerang']),
  item('hookshot', 0xF342, 'Hookshot'),
  // 1 mushroom, 2 magic powder, 0 after giving the mushroom to the witch.
  item('mushroom', 0xF344, ['', 'Mushroom', 'Magic Powder'], { kind: 'set' }),
  item('fireRod', 0xF345, 'Fire Rod'),
  item('iceRod', 0xF346, 'Ice Rod'),
  item('bombos', 0xF347, 'Bombos Medallion'),
  item('ether', 0xF348, 'Ether Medallion'),
  item('quake', 0xF349, 'Quake Medallion'),
  item('lamp', 0xF34A, 'Lamp'),
  item('hammer', 0xF34B, 'Magic Hammer'),
  item('flute', 0xF34C, ['', 'Shovel', 'Flute', 'Flute (bird awake)']),
  item('net', 0xF34D, 'Bug-Catching Net'),
  item('book', 0xF34E, 'Book of Mudora'),
  item('somaria', 0xF350, 'Cane of Somaria'),
  item('byrna', 0xF351, 'Cane of Byrna'),
  item('cape', 0xF352, 'Magic Cape'),
  item('mirror', 0xF353, ['', 'Letter', 'Magic Mirror']),
  item('gloves', 0xF354, ['', 'Power Glove', "Titan's Mitt"], { refresh: 'armor' }),
  item('boots', 0xF355, 'Pegasus Boots'),
  item('flippers', 0xF356, "Zora's Flippers"),
  item('moonPearl', 0xF357, 'Moon Pearl'),
  // 255 while the smiths have it.
  item('sword', 0xF359, ['', "Fighter's Sword", 'Master Sword', 'Tempered Sword', 'Golden Sword'],
    { kind: 'set', refresh: 'sword' }),
  item('shield', 0xF35A, ['', "Fighter's Shield", 'Fire Shield', 'Mirror Shield'],
    { kind: 'set', refresh: 'shield' }),
  item('armor', 0xF35B, ['', 'Blue Mail', 'Red Mail'], { refresh: 'armor' }),

  // Bottles: owning one is shared, what's in it is not. Value is a 4-bit mask
  // of owned slots; a newly shared slot arrives as an empty bottle.
  {
    key: 'bottles', kind: 'bits', len: 1, label: 'Bottle', refresh: 'hud',
    read: (ram) => {
      let m = 0;
      for (let i = 0; i < 4; i++) if (ram.get(0xF35C + i)) m |= 1 << i;
      return [m];
    },
    write: (ram, [m]) => {
      let first = 0;
      for (let i = 0; i < 4; i++) {
        if (!(m & (1 << i))) continue;
        if (!ram.get(0xF35C + i)) ram.set(0xF35C + i, 2);  // 2 = empty bottle
        if (!first) first = i + 1;
      }
      if (first && !ram.get(0xF34F)) ram.set(0xF34F, first);  // selected bottle
    },
  },

  // Small keys, one count per dungeon at $7EF37C + index (Hyrule Castle and
  // the sewers share index 0). Inside a dungeon the game works on a copy at
  // $7EF36F and saves it back when leaving; 0xFF there means "no dungeon".
  {
    key: 'keys', kind: 'counts', len: 14, max: 99, label: 'Small Key', refresh: 'hud',
    read: (ram) => {
      const a = [];
      for (let i = 0; i < 14; i++) a.push(ram.get(0xF37C + i));
      // The live copy, when loaded, is the current count for its dungeon. The
      // game saves it back before unloading it (0xFF), so the saved array is
      // right whenever the copy isn't loaded.
      const d = curDungeon(ram), live = ram.get(0xF36F);
      // With universal keys the copy is the generic count (genericKeys below).
      if (d >= 0 && live !== 0xFF && !ram.genericKeys) a[d] = live;
      return a;
    },
    write: (ram, a) => {
      for (let i = 0; i < 14; i++) ram.set(0xF37C + i, a[i]);
      const d = curDungeon(ram);
      if (d >= 0 && ram.get(0xF36F) !== 0xFF && !ram.genericKeys) ram.set(0xF36F, a[d]);
    },
    addAt: (ram, i, delta) => {
      const clamp = (v) => Math.max(0, Math.min(99, v + delta));
      ram.set(0xF37C + i, clamp(ram.get(0xF37C + i)));
      if (curDungeon(ram) === i && ram.get(0xF36F) !== 0xFF && !ram.genericKeys) ram.set(0xF36F, clamp(ram.get(0xF36F)));
    },
  },
  // Randomizer "retro" mode (universal keys, ram.genericKeys): one key count
  // for every dungeon at $7EF38B. The game keeps $7EF36F equal to it and
  // works on that copy inside dungeons, so the copy is the live count.
  {
    key: 'genericKeys', kind: 'counts', len: 1, max: 99, label: 'Small Key', refresh: 'hud',
    read: (ram) => {
      if (!ram.genericKeys) return [0];
      const live = ram.get(0xF36F);
      return [live !== 0xFF ? live : ram.get(0xF38B)];
    },
    write: (ram, [n]) => {
      if (!ram.genericKeys) return;
      ram.set(0xF38B, n);
      if (ram.get(0xF36F) !== 0xFF) ram.set(0xF36F, n);
    },
    addAt: (ram, i, delta) => {
      if (!ram.genericKeys || i !== 0) return;
      const live = ram.get(0xF36F);
      const n = Math.max(0, Math.min(99, (live !== 0xFF ? live : ram.get(0xF38B)) + delta));
      ram.set(0xF38B, n);
      if (live !== 0xFF) ram.set(0xF36F, n);
    },
  },

  { key: 'compass', kind: 'bits', addr: 0xF364, len: 2 },
  { key: 'bigKey', kind: 'bits', addr: 0xF366, len: 2 },
  { key: 'dungeonMap', kind: 'bits', addr: 0xF368, len: 2 },

  // Heart pieces and containers, counted together in quarter hearts so four
  // pieces turn into a container. The game zeroes the piece count a moment
  // before adding the container, so this is a sum: only increases are sent.
  {
    key: 'heartQuarters', kind: 'sum', max: 80, label: 'Heart', refresh: 'hud',
    read: (ram) => (ram.get(0xF36C) >> 3) * 4 + (ram.get(0xF36B) & 3),
    write: (ram, q) => {
      q = Math.min(q, 80);
      ram.set(0xF36C, (q >> 2) * 8);
      ram.set(0xF36B, q & 3);
    },
  },
  { key: 'bombUpgrades', kind: 'sum', max: 7, ...u8(0xF370), label: 'Bomb capacity', refresh: 'hud' },
  { key: 'arrowUpgrades', kind: 'sum', max: 7, ...u8(0xF371), label: 'Arrow capacity', refresh: 'hud' },

  { key: 'pendants', kind: 'bits', addr: 0xF374, len: 1, label: 'Pendant', refresh: 'hud' },
  { key: 'abilities', kind: 'bits', addr: 0xF379, len: 1 },
  { key: 'crystals', kind: 'bits', addr: 0xF37A, len: 1, label: 'Crystal', refresh: 'hud' },
  { key: 'magic', kind: 'max', ...u8(0xF37B), label: ['', 'Half Magic', 'Quarter Magic'], refresh: 'hud' },

  // Story progress: 1 has sword from uncle, 2 rescued Zelda, 3 beat Agahnim.
  { key: 'progress', kind: 'max', ...u8(0xF3C5) },
  { key: 'progressFlags', kind: 'bits', addr: 0xF3C6, len: 1 },
  { key: 'mapIcons', kind: 'max', ...u8(0xF3C7) },
  { key: 'progressFlags3', kind: 'bits', addr: 0xF3C9, len: 1 },

  // Randomizers only (zero in the plain game): which of the items that share
  // a menu slot the player owns, for swapping with Y in the item menu.
  // $7EF38C: 80 blue boomerang, 40 red boomerang, 20 mushroom, 10 powder,
  // 04 shovel, 02 flute, 01 flute (bird awake). The mushroom is left out:
  // the witch takes it away. $7EF38E: 80 bow, 40 silver bow.
  {
    key: 'swapItems', kind: 'bits', len: 1, refresh: 'hud',
    read: (ram) => [ram.get(0xF38C) & ~0x20 & 0xff],
    write: (ram, [m]) => ram.set(0xF38C, (ram.get(0xF38C) & 0x20) | (m & ~0x20 & 0xff)),
  },
  { key: 'bowFlags', kind: 'bits', addr: 0xF38E, len: 1, refresh: 'hud' },
  // $7EF38D 02: a bomb was found (modes that start without bombs).
  { key: 'bombFound', ...someBits(0xF38D, 0x02), refresh: 'hud' },

  // More randomizer-only progress, from the randomizer's own save layout
  // (z3randomizer sram.asm). Each counts something only one player can pick
  // up, since the places items come from are shared, so the counts add up.
  //
  // Items with a limited number of copies (a second lamp turns into
  // something else), counted per kind.
  { key: 'itemLimits', kind: 'counts', addr: 0xF390, len: 16, max: 255 },
  // NPCs and tablets that already gave their item: library, catfish,
  // Sahasrahla, Stumpy, sick kid, King Zora, old man / magic bat, potion
  // shop, Lost Woods mushroom, smith, Bombos and Ether tablets.
  { key: 'npcItems', kind: 'bits', addr: 0xF410, len: 2 },
  // Dungeon prizes shown on the map (Sahasrahla, bomb shop, maps).
  { key: 'mapOverlay', kind: 'bits', addr: 0xF414, len: 2 },
  // Dungeon prizes taken, so no one else's boss drops it again.
  { key: 'dungeonsDone', kind: 'bits', addr: 0xF472, len: 2 },
  // The bird after Agahnim 2.
  { key: 'aga2Duck', kind: 'max', ...u8(0xF40F) },
  // The Haunted Grove item was dug up.
  { key: 'groveItem', ...someBits(0xF416, 0x01) },
  // Highest sword, shield and mail found, for progressive items.
  { key: 'highestSword', kind: 'max', ...u8(0xF417) },
  { key: 'highestShield', kind: 'max', ...u8(0xF422) },
  { key: 'highestMail', kind: 'max', ...u8(0xF46E) },
  // Triforce Hunt pieces (16-bit), shown on the HUD and counted by Murahdahla.
  { key: 'triforce', kind: 'sum', max: 999, ...u16(0xF418), label: 'a Triforce Piece', refresh: 'hud' },
  // Items collected (16-bit): the HUD's item counter and the "collect
  // everything" goal.
  { key: 'itemCount', kind: 'sum', max: 9999, ...u16(0xF423), refresh: 'hud' },
  // Pendants and crystals found: the randomizer checks these counts, not the
  // bits above, to open Ganon's Tower and the pedestal and to hurt Ganon.
  { key: 'pendantCount', kind: 'sum', max: 255, ...u8(0xF429) },
  { key: 'crystalCount', kind: 'sum', max: 255, ...u8(0xF476) },
  // Per dungeon: locations checked (the "items left" number with the
  // compass) and small keys found in chests (keysanity's key total).
  { key: 'dungeonChecks', kind: 'counts', addr: 0xF4C0, len: 16, max: 255, refresh: 'hud' },
  { key: 'dungeonKeysFound', kind: 'counts', addr: 0xF4E0, len: 16, max: 255, refresh: 'hud' },
];

export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

// Plain byte-array fields read and write their address range directly.
for (const f of FIELDS) {
  if ((f.kind === 'bits' || f.kind === 'counts') && !f.read) {
    f.read = (ram) => { const a = []; for (let i = 0; i < f.len; i++) a.push(ram.get(f.addr + i)); return a; };
    f.write = (ram, a) => { for (let i = 0; i < f.len; i++) ram.set(f.addr + i, a[i]); };
  }
  if (f.kind === 'counts' && !f.addAt) {
    f.addAt = (ram, i, delta) => ram.set(f.addr + i, Math.max(0, Math.min(f.max, ram.get(f.addr + i) + delta)));
  }
}

export const isArrayKind = (f) => f.kind === 'bits' || f.kind === 'counts';

export function emptyValue(f) {
  return isArrayKind(f) ? new Array(f.len).fill(0) : 0;
}

// --- Ops -------------------------------------------------------------------
// An op is the smallest message that describes one player's change:
//   { k, bits: { index: mask } }   bits newly set
//   { k, v }                       new value (max, set)
//   { k, d }                       increase (sum)
//   { k, d: { index: change } }    change, may be negative (counts)

// Apply an op to a field value, returning the new value (does not mutate).
export function applyOp(f, value, op) {
  switch (f.kind) {
    case 'bits': {
      const out = value.slice();
      for (const [i, m] of Object.entries(op.bits)) {
        const idx = Number(i);
        if (idx >= 0 && idx < f.len) out[idx] = (out[idx] | m) & 0xff;
      }
      return out;
    }
    case 'counts': {
      const out = value.slice();
      for (const [i, d] of Object.entries(op.d)) {
        const idx = Number(i);
        if (idx >= 0 && idx < f.len) out[idx] = Math.max(0, Math.min(f.max, out[idx] + d));
      }
      return out;
    }
    case 'max': return Math.max(value, op.v & 0xff);
    case 'set': return op.v & 0xff;
    case 'sum': return Math.max(0, Math.min(f.max ?? 255, value + op.d));
  }
  throw new Error('unknown field kind ' + f.kind);
}

// Is this op well formed for its field? The server checks every op it relays.
export function validOp(op) {
  const f = op && FIELD_BY_KEY[op.k];
  if (!f) return false;
  const int = (x) => Number.isInteger(x);
  switch (f.kind) {
    case 'bits':
      return op.bits && typeof op.bits === 'object' &&
        Object.entries(op.bits).every(([i, m]) => int(Number(i)) && Number(i) >= 0 && Number(i) < f.len && int(m) && m > 0 && m < 256);
    case 'counts':
      return op.d && typeof op.d === 'object' &&
        Object.entries(op.d).every(([i, d]) => int(Number(i)) && Number(i) >= 0 && Number(i) < f.len && int(d) && d !== 0 && Math.abs(d) <= f.max);
    case 'max': case 'set': return int(op.v) && op.v >= 0 && op.v < 256;
    case 'sum': return int(op.d) && op.d > 0 && op.d <= (f.max ?? 255);
  }
  return false;
}

// The ops that turn `from` into `to` for one field, or [] if nothing new.
// For bits and max only gains count; losses are ignored (and repaired).
export function diff(f, from, to) {
  switch (f.kind) {
    case 'bits': {
      const bits = {};
      let any = false;
      for (let i = 0; i < f.len; i++) {
        const m = to[i] & ~from[i] & 0xff;
        if (m) { bits[i] = m; any = true; }
      }
      return any ? [{ k: f.key, bits }] : [];
    }
    case 'counts': {
      if (!to) return [];  // not readable right now
      const d = {};
      let any = false;
      for (let i = 0; i < f.len; i++) {
        if (to[i] !== from[i]) { d[i] = to[i] - from[i]; any = true; }
      }
      return any ? [{ k: f.key, d }] : [];
    }
    case 'max': return to > from ? [{ k: f.key, v: to }] : [];
    case 'set': return to !== from ? [{ k: f.key, v: to }] : [];
    case 'sum': return to > from ? [{ k: f.key, d: to - from }] : [];
  }
  return [];
}

// The shared part of the save, or null if some of it can't be read right now
// (mid-transition); try again next tick.
export function snapshot(ram) {
  const out = {};
  for (const f of FIELDS) {
    const v = f.read(ram);
    if (v === null) return null;
    out[f.key] = v;
  }
  return out;
}

// What an op did, for notices like "Sam got Hookshot". Returns null for ops
// that aren't worth announcing (map flags etc.).
export function describeOp(op, value) {
  const f = FIELD_BY_KEY[op.k];
  if (!f || !f.label) return null;
  if (f.kind === 'counts') {
    const n = Object.values(op.d).reduce((a, b) => a + b, 0);
    return n > 0 ? 'got a Small Key' : n < 0 ? 'used a Small Key' : null;
  }
  if (f.key === 'heartQuarters') return op.d >= 4 ? 'got a Heart Container' : 'got a Piece of Heart';
  const name = Array.isArray(f.label) ? f.label[value] : f.label;
  return name ? 'got ' + name : null;
}
