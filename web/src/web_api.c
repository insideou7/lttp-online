// Functions the web page calls into the game (exported to JavaScript).
// They expose game memory so the page can save, inspect and, later,
// sync shared progress between players.
#include <emscripten.h>
#include "src/types.h"
#include "src/variables.h"
#include "src/zelda_rtl.h"
#include "src/hud.h"
#include "src/load_gfx.h"
#include "snes/ppu.h"

// Work RAM ($7E0000-$7FFFFF), 128 KiB. The save file being played lives at
// $7EF000-$7EF4FF (items at $7EF340+, hearts at $7EF36C, etc.).
EMSCRIPTEN_KEEPALIVE uint8 *web_ram(void) { return g_ram; }
EMSCRIPTEN_KEEPALIVE int web_ram_size(void) { return sizeof(g_ram); }

// Battery-backed SRAM (8 KiB): the three save slots on the file select screen.
EMSCRIPTEN_KEEPALIVE uint8 *web_sram(void) { return g_zenv.sram; }

// Video memory, for drawing other players' Link (web/site/sync/presence.js):
// VRAM (64 KiB, 16-bit words), CGRAM (256 15-bit colors), and where sprite
// tiles live (OBSEL): web_obj_info() = table 1 word address | table 2 << 16,
// and web_obj_size() = the OBSEL size setting (0 = 8x8 and 16x16 in this game).
EMSCRIPTEN_KEEPALIVE uint16 *web_vram(void) { return g_zenv.ppu->vram; }
EMSCRIPTEN_KEEPALIVE uint16 *web_cgram(void) { return g_zenv.ppu->cgram; }
EMSCRIPTEN_KEEPALIVE uint32 web_obj_info(void) {
  return g_zenv.ppu->objTileAdr1 | (uint32)g_zenv.ppu->objTileAdr2 << 16;
}
EMSCRIPTEN_KEEPALIVE int web_obj_size(void) { return g_zenv.ppu->objSize; }

// Redraw after multiplayer sync wrote another player's unlock into the save
// area. mask: 1 HUD and equipped item, 2 sword, 4 shield, 8 armor and gloves.
// The page calls this between frames, only during normal overworld/dungeon play.
EMSCRIPTEN_KEEPALIVE void web_refresh(int mask) {
  if (mask & 1) Hud_RefreshIcon();
  // Sword 255 means the smiths have it; the graphics tables stop at 4 and 3.
  if ((mask & 2) && link_sword_type <= 4) { DecompressSwordGraphics(); Palette_Load_Sword(); }
  if ((mask & 4) && link_shield_type <= 3) { DecompressShieldGraphics(); Palette_Load_Shield(); }
  if (mask & 8) Palette_Load_LinkArmorAndGloves();
}

// The desktop OpenGL output path isn't built for the web (it needs desktop GL).
// The web build always uses the SDL renderer, which Emscripten maps to WebGL.
struct RendererFuncs;
void NORETURN Die(const char *error);
void OpenGLRenderer_Create(struct RendererFuncs *funcs, bool use_opengl_es) {
  (void)funcs, (void)use_opengl_es;
  Die("OpenGL output isn't available in the browser. Use OutputMethod = SDL.");
}
