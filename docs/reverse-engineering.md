# Reverse engineering toolkit

`tools/setup-re-toolkit.sh` installs everything below into `/opt/re`. In Claude Code
cloud sessions it runs automatically from the SessionStart hook in `.claude/settings.json`.
Locally, run it once yourself (it uses apt and may need sudo).

| Tool | Where | What it's for |
| --- | --- | --- |
| [REA](https://github.com/morluto/rea) 6.7.0 | `rea` CLI, `rea` MCP server (`.mcp.json`), skill in `.claude/skills/` | Agent-driven RE with evidence. Uses Ghidra as its backend here. |
| Ghidra 12.1.4 | `$GHIDRA_INSTALL_DIR` | Disassembly/decompilation; headless via `analyzeHeadless`. |
| 65816 processor module | `Ghidra/Processors/65816` | Lets Ghidra read SNES (65816) code. Patched for Ghidra 12. |
| asar 1.91 | `/opt/re/bin/asar` | 65816 assembler, for test ROMs and patches. |
| snesrev/zelda3 | `/opt/re/src/zelda3` | Full C reimplementation of the game (built as `zelda3`). |
| spannerisms/jpdasm | `/opt/re/src/jpdasm` | Full commented disassembly of JP 1.0, with names for routines and RAM. |

## What each tool can and can't do for this project

**REA does not understand SNES code.** Its Ghidra lane only admits x86, x86_64,
ARM/ARM64, NMOS 6502 and 68000; 65816 is explicitly rejected
(see its `docs/raw-binary.md`). So don't point REA at the ROM. It is useful for:

- the native `zelda3` binary and, later, our own WebAssembly build (`inspect_wasm_artifact`,
  `compare-wasm-interfaces`) to check what we ship;
- the browser client itself (`analyze-web-bundle`, `capture-browser-scenario`, network captures).

**For the ROM, use Ghidra directly with the 65816 module**:

```bash
tools/ghidra/import-rom.sh roms/zelda3.sfc      # maps LoROM banks to $BB:8000-$BB:FFFF
```

`LoRomMap.java` labels and disassembles from the NMI/IRQ/RESET vectors, starting RESET
in emulation mode (8-bit registers) so the boot code decodes the same as jpdasm. The module's
disassembly is good; its decompiler output is weak, and M/X flag tracking after `PLP`/`RTI`
needs manual "Set Register Values". In practice the jpdasm labels and the zelda3 C
source answer most "what does this routine do" questions faster than Ghidra does.

## The shortcut

snesrev/zelda3 already reimplements the whole game in C (playable start to finish) and can
run the original ROM side by side, comparing RAM every frame. For a browser client the
likely path is compiling it to WebAssembly with Emscripten (SDL2 has an Emscripten port),
rather than re-deriving the game from the ROM. Its assets still come from the player's own
ROM (`assets/restool.py --extract-from-rom`), which suits a "bring your own ROM" web client.

To check the C code against the original, copy your ROM into `/opt/re/src/zelda3/`, extract
assets, and run `./zelda3 zelda3.sfc`: it runs the ROM alongside the C code and reports any
RAM difference. Headless: `SDL_AUDIODRIVER=dummy xvfb-run ./zelda3 zelda3.sfc`.

## ROM policy

No ROM or extracted asset is ever committed or downloaded by our scripts. See `roms/README.md`.

## Not installed (yet)

- A GUI SNES debugger (Mesen 2, bsnes-plus). They need a desktop; use them locally.
- Futaba, the assembler jpdasm builds with (needed only to reassemble the disassembly).
- Emscripten, for the WebAssembly build. `web/build.sh` needs it; see `docs/web-client.md`.
