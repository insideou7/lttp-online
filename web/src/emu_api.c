// Functions the web page calls into the SNES emulator core (LakeSnes, MIT,
// https://github.com/dinkc64/LakeSnes), for running randomizer ROMs that
// zelda3 can't play. web/site/emu.js drives it; build.sh compiles it to
// dist/snes.js + snes.wasm.
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include "snes.h"

static Snes *snes;
static uint8_t pixels[512 * 480 * 4];
static int16_t samples[2048 * 2];

// Loads a ROM (copier header or not) and resets. 1 on success.
EMSCRIPTEN_KEEPALIVE int emu_load(const uint8_t *rom, int length) {
  if (!snes) snes = snes_init();
  return snes_loadRom(snes, rom, length);
}

// Runs one frame with these buttons held on controller 1. Bits follow
// LakeSnes: 0 B, 1 Y, 2 Select, 3 Start, 4 Up, 5 Down, 6 Left, 7 Right,
// 8 A, 9 X, 10 L, 11 R.
EMSCRIPTEN_KEEPALIVE void emu_frame(int buttons) {
  snes->input1->currentState = buttons;
  snes_runFrame(snes);
}

// The last frame as 512x480 RGBA, ready for a canvas ImageData (each SNES
// pixel doubled; without overscan the picture is lines 16-463).
EMSCRIPTEN_KEEPALIVE uint8_t *emu_pixels(void) {
  snes_setPixels(snes, pixels);
  // The core writes B, G, R, unused: make it R, G, B, opaque.
  for (int i = 0; i < (int)sizeof(pixels); i += 4) {
    uint8_t b = pixels[i];
    pixels[i] = pixels[i + 2];
    pixels[i + 2] = b;
    pixels[i + 3] = 0xff;
  }
  return pixels;
}

// The last frame's audio resampled to `count` stereo int16 pairs.
EMSCRIPTEN_KEEPALIVE int16_t *emu_samples(int count) {
  if (count > 2048) count = 2048;
  snes_setSamples(snes, samples, count);
  return samples;
}

// Work RAM ($7E0000-$7FFFFF), same layout zelda3 uses: the multiplayer sync
// and presence code read the game's own variables from it.
EMSCRIPTEN_KEEPALIVE uint8_t *emu_ram(void) { return snes->ram; }

// Video memory, to picture this player's Link for the others (presence.js).
EMSCRIPTEN_KEEPALIVE uint16_t *emu_vram(void) { return snes->ppu->vram; }
EMSCRIPTEN_KEEPALIVE uint16_t *emu_cgram(void) { return snes->ppu->cgram; }
EMSCRIPTEN_KEEPALIVE uint32_t emu_obj_info(void) {
  return snes->ppu->objTileAdr1 | (uint32_t)snes->ppu->objTileAdr2 << 16;
}
EMSCRIPTEN_KEEPALIVE int emu_obj_size(void) { return snes->ppu->objSize; }

// Battery-backed cart RAM (the save files). Size 0 if the cart has none.
EMSCRIPTEN_KEEPALIVE int emu_sram_size(void) { return snes->cart->hasBattery ? snes->cart->ramSize : 0; }
EMSCRIPTEN_KEEPALIVE uint8_t *emu_sram(void) { return snes->cart->hasBattery ? snes->cart->ram : NULL; }

// Save states: emu_state_save() returns a malloc'd buffer the page frees,
// with its size in *size.
EMSCRIPTEN_KEEPALIVE uint8_t *emu_state_save(int *size) {
  *size = snes_saveState(snes, NULL);
  uint8_t *data = malloc(*size);
  snes_saveState(snes, data);
  return data;
}
EMSCRIPTEN_KEEPALIVE int emu_state_load(uint8_t *data, int size) {
  return snes_loadState(snes, data, size);
}

EMSCRIPTEN_KEEPALIVE void emu_reset(void) { snes_reset(snes, false); }

// Runs one of the game's own subroutines (a JSL target that ends in RTL), the
// way the game would: used to redraw the HUD and reload Link's sword, shield
// and armor after the multiplayer sync wrote another player's unlock into RAM.
//
// It only runs while A Link to the Past's main loop is idle, waiting for the
// next frame (`LDA $12 : BEQ` at $00:8034), with the loop's registers. The
// return address points the RTL back into that loop; registers are restored
// after. An NMI that fires meanwhile is handled as usual. Returns 1 if it ran,
// 0 if the game wasn't idle (the page tries again next frame).
#define IDLE_PC 0x8034
EMSCRIPTEN_KEEPALIVE int emu_call(uint32_t adr) {
  Cpu *c = snes->cpu;
  if (c->k != 0 || (c->pc != IDLE_PC && c->pc != IDLE_PC + 2) || c->e) return 0;
  Cpu saved = *c;
  // Push the return address for RTL (it adds 1): $00:8033 -> back to $00:8034.
  uint16_t sp = c->sp;
  snes_write(snes, sp, 0x00);
  snes_write(snes, (uint16_t)(sp - 1), (IDLE_PC - 1) >> 8);
  snes_write(snes, (uint16_t)(sp - 2), (IDLE_PC - 1) & 0xff);
  c->sp = sp - 3;
  c->k = adr >> 16;
  c->pc = adr & 0xffff;
  // Plenty for a HUD rebuild or a graphics decompression (about 2 frames).
  for (int i = 0; i < 200000; i++) {
    cpu_runOpcode(c);
    if (c->k == 0 && c->pc == IDLE_PC && c->sp == sp) break;
  }
  // Back in the loop: restore its registers. The pc check above failing would
  // mean the routine never returned; restoring still leaves the loop intact.
  c->a = saved.a; c->x = saved.x; c->y = saved.y; c->sp = saved.sp;
  c->dp = saved.dp; c->db = saved.db; c->k = saved.k; c->pc = saved.pc;
  c->c = saved.c; c->z = saved.z; c->v = saved.v; c->n = saved.n;
  c->i = saved.i; c->d = saved.d; c->xf = saved.xf; c->mf = saved.mf;
  return 1;
}
