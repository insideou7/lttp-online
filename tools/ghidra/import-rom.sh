#!/usr/bin/env bash
# Import a LoROM SNES ROM into a Ghidra project with the 65816 module,
# mapped at real bus addresses and disassembled from the hardware vectors.
# Usage: tools/ghidra/import-rom.sh roms/zelda3.sfc [project_dir]
set -euo pipefail
rom=$(realpath "$1"); proj=${2:-work/ghidra}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$proj"
"${GHIDRA_INSTALL_DIR:?run tools/setup-re-toolkit.sh first}/support/analyzeHeadless" \
  "$(realpath "$proj")" lttp -import "$rom" -overwrite \
  -processor 65816:LE:16:default -loader BinaryLoader -noanalysis \
  -scriptPath "$here" -postScript LoRomMap.java
