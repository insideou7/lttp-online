// Sync backend for the zelda3 WebAssembly build (see client.js for the interface).

// Main modules ($7E0010) during which the save area holds the loaded file and
// gameplay is running: loading into the world, dungeon, overworld, menus,
// game over, boss victory, mirror warp, spawn select. Not intro, file select,
// attract demo, save-and-quit, or the ending.
const IN_GAME_MODULES = new Set([
  0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x15, 0x16, 0x18, 0x1B,
]);

const REFRESH_BITS = { hud: 1, sword: 2, shield: 4, armor: 8 };

export function zelda3Backend(game) {
  const base = () => game._web_ram();   // the heap can move if memory grows
  const ram = {
    get: (addr) => game.HEAPU8[base() + addr],
    set: (addr, v) => { game.HEAPU8[base() + addr] = v; },
  };
  // The PPU's video memory, to picture this player's Link for the others.
  const u16 = (ptr, i) => game.HEAPU8[ptr + i * 2] | (game.HEAPU8[ptr + i * 2 + 1] << 8);
  const OBJ_SIZES = [[8, 16], [8, 32], [8, 64], [16, 32], [16, 64], [32, 64], [16, 32], [16, 32]];
  const video = {
    vram: (word) => u16(game._web_vram(), word),
    cgram: (i) => u16(game._web_cgram(), i),
    objBase: (table) => {
      const info = game._web_obj_info() >>> 0;
      return table ? info >>> 16 : info & 0xffff;
    },
    objSizes: () => OBJ_SIZES[game._web_obj_size() & 7],
  };
  return {
    ram,
    video: game._web_vram ? video : undefined,
    // The four 8x8 tile words of overworld map16 tile v (tiles.js).
    map16: game._web_map16_table
      ? (v) => [0, 1, 2, 3].map((i) => u16(game._web_map16_table(), v * 4 + i))
      : undefined,
    inGame: () => IN_GAME_MODULES.has(ram.get(0x10)),
    // Redraw only in plain dungeon/overworld play (no menu, dialog or
    // transition running), so it never interrupts the game's own drawing.
    refresh(kinds) {
      const module = ram.get(0x10), sub = ram.get(0x11);
      if (!((module === 0x07 || module === 0x09) && sub === 0)) return false;
      let mask = 0;
      for (const k of kinds) mask |= REFRESH_BITS[k] ?? 0;
      game._web_refresh(mask);
      return true;
    },
  };
}
