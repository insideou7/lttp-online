# lttp-online

Goal: reverse engineer The Legend of Zelda: A Link to the Past (SNES) and build a client
playable in the browser.

- RE tools live in `/opt/re`, installed by `tools/setup-re-toolkit.sh` (runs on session start).
  Details and limits: `docs/reverse-engineering.md`.
- REA (MCP server `rea`) cannot analyze 65816/SNES code. Use Ghidra + the 65816 module
  (`tools/ghidra/import-rom.sh`) for the ROM; use REA for native/WASM/web artifacts.
- Reference sources: `/opt/re/src/zelda3` (C reimplementation), `/opt/re/src/jpdasm` (JP 1.0 disassembly).
- Never download, commit or share a ROM or extracted assets. The user supplies their own in `roms/`.
