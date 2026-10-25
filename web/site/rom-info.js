// What ROM the player picked: the plain US game (runs on zelda3) or anything
// else based on A Link to the Past, such as a randomizer seed (runs on the
// SNES emulator core). Also gives each game an id, so a multiplayer room can
// make sure everyone plays the same seed.

export const US_ROM_SHA1 = '6d4f10a8b10e10dbe624cb23cf03b88bb8252973';
export const VANILLA_GAME_ID = 'lttp-us';

// Unmodified copies of the game that randomizer seeds are built from. A room
// sends a seed as a patch against one of these, and each player rebuilds the
// seed from their own copy. ALttPR seeds are made from the Japanese 1.0 ROM.
export const BASE_ROMS = {
  [US_ROM_SHA1]: 'US',
  'e7e852f0159ce612e3911164878a9b08b3cb9060': 'Japanese 1.0',
};

// Randomizers (ALttPR, door/entrance randomizers, Archipelago) write a
// five-icon "code" for the seed at this ROM offset; it's shown on the file
// select screen, so players can compare it at a glance.
const SEED_CODE_OFFSET = 0x180215;
const SEED_CODE_ICONS = [
  'Bow', 'Boomerang', 'Hookshot', 'Bomb', 'Mushroom', 'Powder', 'Rod', 'Pendant', 'Bombos', 'Ether',
  'Quake', 'Lamp', 'Hammer', 'Shovel', 'Ocarina', 'Bug Net', 'Book', 'Bottle', 'Potion', 'Cane',
  'Cape', 'Mirror', 'Boots', 'Gloves', 'Flippers', 'Pearl', 'Shield', 'Tunic', 'Heart', 'Map',
  'Compass', 'Key',
];

export async function sha1Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Drops a 512-byte copier header (.smc files often have one).
export function stripHeader(rom) {
  return (rom.length & 0x7fff) === 0x200 ? rom.slice(0x200) : rom;
}

// LoROM header title, 21 bytes at $7FC0, trimmed.
function title(rom) {
  let s = '';
  for (let i = 0x7fc0; i < 0x7fd5; i++) {
    const c = rom[i];
    if (c === 0) break;
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '?';
  }
  return s.trim();
}

// Facts about a header-less ROM. Throws if it isn't A Link to the Past or a
// game built from it.
export async function identifyRom(rom) {
  const sha1 = await sha1Hex(rom);
  if (sha1 === US_ROM_SHA1) {
    return { sha1, vanilla: true, base: BASE_ROMS[sha1], title: 'THE LEGEND OF ZELDA', gameId: VANILLA_GAME_ID, label: 'A Link to the Past (US)' };
  }
  if (rom.length < 0x100000 || rom.length > 0x400000) {
    throw new Error('This file is not a Link to the Past ROM (wrong size).');
  }
  const name = title(rom);
  // The game's LoROM reset vector and NMI vector, which randomizers keep.
  const resetVec = rom[0x7ffc] | (rom[0x7ffd] << 8);
  const looksLikeLttp = resetVec === 0x8000 && rom[0] === 0x78;   // SEI at $00:8000
  if (!looksLikeLttp) {
    throw new Error(`"${name || 'This ROM'}" doesn't look like A Link to the Past or a randomizer of it.`);
  }
  let code = null;
  if (rom.length >= SEED_CODE_OFFSET + 5) {
    code = [...rom.subarray(SEED_CODE_OFFSET, SEED_CODE_OFFSET + 5)];
    if (code.some((c) => c >= SEED_CODE_ICONS.length)) code = null;   // not a randomizer's code
  }
  const codeNames = code?.map((c) => SEED_CODE_ICONS[c]);
  return {
    sha1,
    vanilla: false,
    base: BASE_ROMS[sha1],   // an original game, e.g. the Japanese ROM ALttPR uses
    title: name,
    code: codeNames ?? null,
    // Cosmetic options (Link's sprite, heart color, music) change the ROM's
    // bytes but not its title or code, so friends' copies of one seed match.
    gameId: code ? `seed:${name}:${code.map((c) => c.toString(16).padStart(2, '0')).join('')}` : `rom:${sha1}`,
    label: codeNames ? `seed ${codeNames.join(', ')}` : name || 'modified ROM',
  };
}
