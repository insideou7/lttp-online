// Functions the web page calls into the game (exported to JavaScript).
// They expose game memory so the page can save, inspect and, later,
// sync shared progress between players.
#include <emscripten.h>
#include "src/types.h"
#include "src/variables.h"
#include "src/zelda_rtl.h"

// Work RAM ($7E0000-$7FFFFF), 128 KiB. The save file being played lives at
// $7EF000-$7EF4FF (items at $7EF340+, hearts at $7EF36C, etc.).
EMSCRIPTEN_KEEPALIVE uint8 *web_ram(void) { return g_ram; }
EMSCRIPTEN_KEEPALIVE int web_ram_size(void) { return sizeof(g_ram); }

// Battery-backed SRAM (8 KiB): the three save slots on the file select screen.
EMSCRIPTEN_KEEPALIVE uint8 *web_sram(void) { return g_zenv.sram; }

// The desktop OpenGL output path isn't built for the web (it needs desktop GL).
// The web build always uses the SDL renderer, which Emscripten maps to WebGL.
struct RendererFuncs;
void NORETURN Die(const char *error);
void OpenGLRenderer_Create(struct RendererFuncs *funcs, bool use_opengl_es) {
  (void)funcs, (void)use_opengl_es;
  Die("OpenGL output isn't available in the browser. Use OutputMethod = SDL.");
}
