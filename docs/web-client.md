# Browser client

`web/` builds A Link to the Past for the browser from the
[snesrev/zelda3](https://github.com/snesrev/zelda3) C reimplementation, compiled to WebAssembly.

```bash
EMSDK=/path/to/emsdk web/build.sh               # about 1 minute, output in web/dist/
python3 -m http.server -d web/dist 8080         # then open http://localhost:8080
node server/index.js --static web/dist          # same, plus the multiplayer server
```

`web/dist/` is a static site (about 17 MB). Any static host works; it needs no special headers.

## Hosting

`.github/workflows/web.yml` builds the site on every push to `main` (and checks pull requests)
with emsdk 4.0.10, fails if any ROM or `zelda3_assets.dat` ended up in `dist/`, and deploys it.
The repository variable `DEPLOY_TARGET` picks where:

- `cloudflare`: Cloudflare Workers static assets, free, works with a private repo. Config is
  `web/wrangler.toml`; the site lands on `https://lttp-online.<account>.workers.dev`. One-time
  setup: create a Cloudflare API token with the "Edit Cloudflare Workers" template and add repo
  secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The multiplayer sync server can later
  become this Worker's script (a Durable Object per room) on the same origin.
- `pages`: GitHub Pages (free only for public repos), also the default when the variable is unset
  and the repo is public. Set Settings > Pages > Source to "GitHub Actions". The site works under a subpath since every URL in it is relative.
- unset on a private repo: build only; the built site is kept as the `web-dist` run artifact for 7 days.

Deploy by hand with `cd web && npx wrangler@4 deploy` after `web/build.sh`.

## How it works

1. **The player brings their own ROM.** The page asks for the US ROM, strips a copier header if
   present and checks its SHA-1 (`6d4f10a8…`). The ROM never leaves the browser and is not stored.
2. **Assets are extracted in the browser.** zelda3 needs `zelda3_assets.dat`, made by its Python
   tool `assets/restool.py`. A Web Worker (`site/extract-worker.js`) runs that tool unchanged in
   [Pyodide](https://pyodide.org) 0.27.7 (Python in WebAssembly, with Pillow and PyYAML). It takes
   about 15 s and the output is byte-identical to the native tool. The result is kept in the
   browser's IndexedDB, so later visits go straight to "Play".
3. **The game runs as WebAssembly.** `build.sh` compiles zelda3 with Emscripten and its SDL2 port
   (SDL's renderer maps to WebGL, audio to Web Audio). Pyodide and the tool's scripts are copied
   into `dist/` too, so the site loads nothing from a CDN.
4. **Saves persist.** `saves/` is an IndexedDB-backed folder (Emscripten IDBFS). The game tells the
   page when it writes SRAM or a save state, and the page flushes it to IndexedDB.

## What the build changes in zelda3

zelda3 is pinned to a commit in `build.sh` and patched with `web/patches/zelda3-web.patch`:

- `src/main.c`: the main loop is split into `RunOneIteration()` (native, unchanged behaviour) and
  `WebMainLoop()`, which the browser calls every animation frame. It runs one 60 Hz game frame per
  16.7 ms of real time, so 120 Hz screens don't speed the game up, and draws once.
- `Die()` reports fatal errors to the page (`Module.onFatalError`).
- `src/zelda_rtl.c`: calls `Module.onSavesChanged` after writing SRAM or a save state.

`web/src/web_api.c` adds exports for the page: `web_ram()` (128 KiB WRAM), `web_ram_size()`,
`web_sram()` (8 KiB SRAM), and `web_refresh()`, which redraws the HUD and gear after multiplayer
sync changes them, plus `web_vram()`, `web_cgram()`, `web_obj_info()` and `web_obj_size()`, which
let the page draw this player's Link for the others. From the console, `lttp.HEAPU8[lttp._web_ram() + 0x10]` is the current game
module, for example.

The desktop OpenGL output is not built; the web config forces `OutputMethod = SDL`. The page's
`zelda3.ini` is upstream's with `WindowScale = 3`, `AudioSamples = 1024` and autosave off.
Keyboard controls come from `web/keymap.ini` (WASD to move, F/G = Select/Start, J/M = A/B,
I/L = X/Y, Q/E = L/R; arrows, Enter and Right Shift still work). `build.sh` drops upstream's
`[KeyMap]` entries with the same names and appends that file, which also unbinds zelda3's
single-letter cheat and debug keys. To remap, edit that file and the table in `web/site/index.html`.

## Updating zelda3

Change `ZELDA3_COMMIT` in `build.sh`, run it, and fix the patch if it no longer applies (work in
`web/.cache/zelda3`, then `git -C web/.cache/zelda3 diff > web/patches/zelda3-web.patch`; zelda3
uses CRLF line endings). Assets are cached per zelda3 commit, so players re-extract after an update.

## Next steps

- **Multiplayer** is in: see [multiplayer.md](multiplayer.md).
- **Randomizer seeds** run on the SNES emulator, below.

## Randomizer seeds

Randomizers (ALttPR, the door and entrance randomizers, Archipelago) patch the game's code, so
zelda3 can't play them. The page runs any other ROM based on the game on an SNES emulator core
instead: [LakeSnes](https://github.com/dinkc64/LakeSnes) (MIT, dinkc64's maintained fork), pinned
in `build.sh` and compiled to `dist/snes.js` + `snes.wasm` (about 140 KB). It takes about 3 ms per
frame in Chromium.

- **Loading.** The ROM picker takes either ROM. `site/rom-info.js` identifies it: the US ROM goes
  to zelda3 as before; anything else that looks like the game (LoROM, the game's reset code) is
  kept in IndexedDB (`seed-rom`, this browser only) and offered as **Play seed**. Randomizers are
  generated from the Japanese 1.0 ROM, which the player supplies to the randomizer, not to us.
- **Which seed.** Randomizers write a five-icon code for the seed at ROM offset `$180215` (shown on
  the file select screen). The game id is the ROM title plus that code, so cosmetic options
  (Link's sprite, heart color, music) don't make friends' copies differ. ROMs without a code use
  their SHA-1.
- **Running it.** `site/emu.js` runs frames at 60.1 Hz from `requestAnimationFrame`, draws the
  512x448 picture to the canvas, plays sound through an AudioWorklet, and maps keys from the same
  `keymap.ini` the zelda3 build uses (copied to `dist/`), plus gamepads. Tab held is turbo;
  Shift+F1-F10 saves a state, F1-F10 loads it. Battery saves and states are in IndexedDB per game
  id, so each seed has its own save files.
- **C side.** `web/src/emu_api.c` exports the frame, picture, sound, RAM, VRAM/CGRAM, SRAM and
  state functions, and `emu_call(addr)`, which runs one of the game's own subroutines while its
  main loop is idle (`LDA $12 : BEQ` at `$00:8034`). The multiplayer backend
  (`site/sync/snes-backend.js`) uses it to redraw the HUD and reload Link's sword, shield and armor
  after another player's unlock arrives: it finds those routines at their US or Japanese 1.0
  addresses by their first bytes, and skips a redraw if a randomizer rewrote the routine.

