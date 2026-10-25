// Sync backend for the SNES emulator core (web/site/emu.js), which runs
// randomizer ROMs. Same interface as zelda3-backend.js (see client.js): the
// game's work RAM has the same layout on a real SNES, so the sync, presence,
// shared enemies and room objects read and write the same addresses.
import { IN_GAME_MODULES, OBJ_SIZES } from './zelda3-backend.js';

// The game's own routines that redraw things after the sync changes the save
// area, called with emu.call() while the game is idle between frames. The US
// and Japanese 1.0 ROMs (randomizers are built from the latter) have some at
// different addresses, so each lists where to look and the start of its code
// to recognize it (?? = any byte, e.g. a JSR target that differs). A ROM that
// has none of them (a randomizer that rewrote one) just skips that redraw;
// the game redraws on its own at the next room or area change.
const ROUTINES = {
  // RefreshItemIcon ($0DDB7F): equipped item box and the whole HUD.
  hud: { at: [0x0DDB7F], code: '8b4bab 20???? 20???? 20???? e230 9c0002 ab 6b' },
  // DecompressSwordGraphics / DecompressShieldGraphics: Link's sword and shield tiles.
  swordGfx: { at: [0x00D2C8, 0x00D308], code: '8b4bab a05f20???? a05e20???? c221 af59f37e' },
  shieldGfx: { at: [0x00D308, 0x00D348], code: '8b4bab a05f20???? a05e20???? c221 af5af37e' },
  // PaletteLoad_Sword / _Shield / _LinkArmorAndGloves.
  swordPal: { at: [0x1BED03], code: 'c221 af59f37e' },
  shieldPal: { at: [0x1BED29], code: 'c221 af5af37e' },
  armorPal: { at: [0x1BEDF9], code: 'c221 af5bf37e' },
};
const REFRESH_ROUTINES = {
  hud: ['hud'],
  sword: ['swordGfx', 'swordPal'],
  shield: ['shieldGfx', 'shieldPal'],
  armor: ['armorPal'],
};

// LoROM address -> offset in a header-less ROM.
const romOffset = (adr) => ((adr >> 16) & 0x7f) * 0x8000 + (adr & 0x7fff);

function matches(rom, adr, code) {
  const want = code.replace(/\s+/g, '').match(/../g);
  const at = romOffset(adr);
  if (at + want.length > rom.length) return false;
  return want.every((h, i) => h === '??' || rom[at + i] === parseInt(h, 16));
}

// Where each routine is in this ROM, or nothing if it isn't recognizable.
export function findRoutines(rom) {
  const found = {};
  for (const [name, r] of Object.entries(ROUTINES)) {
    const adr = r.at.find((a) => matches(rom, a, r.code));
    if (adr !== undefined) found[name] = adr;
  }
  return found;
}

export function snesBackend(emu) {
  const heap = () => emu.core.HEAPU8;   // the heap can move if memory grows
  const ram = {
    get: (addr) => heap()[emu.ram() + addr],
    set: (addr, v) => { heap()[emu.ram() + addr] = v; },
  };
  const u16 = (ptr, i) => heap()[ptr + i * 2] | (heap()[ptr + i * 2 + 1] << 8);
  const video = {
    vram: (word) => u16(emu.core._emu_vram(), word),
    cgram: (i) => u16(emu.core._emu_cgram(), i),
    objBase: (table) => {
      const info = emu.core._emu_obj_info() >>> 0;
      return table ? info >>> 16 : info & 0xffff;
    },
    objSizes: () => OBJ_SIZES[emu.core._emu_obj_size() & 7],
  };
  const routines = findRoutines(emu.rom);
  // Overworld map16 -> map8 table ($0F:8000 in the US and Japanese ROMs, 3752
  // tiles of four 8x8 tile words), for redrawing other players' bushes (tiles.js).
  const map16Base = romOffset(0x0F8000);
  const map16 = (v) => [0, 1, 2, 3].map((i) => {
    const at = map16Base + (v * 4 + i) * 2;
    return emu.rom[at] | (emu.rom[at + 1] << 8);
  });
  return {
    ram,
    video,
    map16,
    routines,
    inGame: () => IN_GAME_MODULES.has(ram.get(0x10)),
    // Called after every emulated frame, between frames.
    onFrame: emu.onFrame,
    // Runs a game subroutine (JSL/RTL) while the main loop is idle; false if
    // the game was busy (try again later).
    call: emu.call,
    // Redraw only in plain dungeon/overworld play, like the zelda3 backend.
    refresh(kinds) {
      const module = ram.get(0x10), sub = ram.get(0x11);
      if (!((module === 0x07 || module === 0x09) && sub === 0)) return false;
      const todo = [];
      for (const k of kinds) {
        // Sword 255 means the smiths have it; the game's tables stop at 4 and 3.
        if (k === 'sword' && ram.get(0xF359) > 4) continue;
        if (k === 'shield' && ram.get(0xF35A) > 3) continue;
        for (const name of REFRESH_ROUTINES[k] ?? []) if (routines[name] !== undefined) todo.push(routines[name]);
      }
      if (!todo.length) return true;
      // The first call tells whether the game is idle; the rest then are too,
      // since each returns to the idle loop.
      if (!emu.call(todo[0])) return false;
      for (const adr of todo.slice(1)) emu.call(adr);
      return true;
    },
  };
}
