#!/usr/bin/env bash
# Installs the LTTP reverse engineering toolkit into $RE_HOME (default /opt/re).
# Safe to re-run: each step is skipped when already done.
# Never downloads the game ROM. Put your own copy at roms/zelda3.sfc (US) or
# roms/alttp-jp10.sfc (JP 1.0); roms/ is gitignored.
set -euo pipefail

RE_HOME="${RE_HOME:-/opt/re}"
SRC="$RE_HOME/src"
GHIDRA_VER=12.1.4
GHIDRA_DATE=20260921
GHIDRA_SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db
GHIDRA_DIR="$RE_HOME/ghidra_${GHIDRA_VER}_PUBLIC"
REA_VERSION=6.7.0

# Pinned upstream commits (bump deliberately).
ZELDA3_REV=45a149d8b4bb8098f53d1009f76e76e7d8b79bbf      # snesrev/zelda3 (C reimplementation)
JPDASM_REV=4535f694752d1469ede65083e986ce2101945264      # spannerisms/jpdasm (JP 1.0 disassembly)
ASAR_REV=5fd539cd510e4a26afef66fc14e35ca6d8ff0497        # RPGHacker/asar (65816 assembler)
G65816_REV=b70cb21d5297ebae8dee54e5d140bacd612d670c      # achan1989/ghidra-65816 (processor module)

log() { echo "[re-setup] $*" >&2; }
mkdir -p "$SRC" "$RE_HOME/dl" "$RE_HOME/bin"
BUILD_LOG="$RE_HOME/setup-build.log"

clone_at() { # repo dir rev
  local repo=$1 dir=$2 rev=$3
  if [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)" = "$rev" ]; then return; fi
  rm -rf "$dir"
  git init -q "$dir"
  git -C "$dir" remote add origin "https://github.com/$repo"
  git -C "$dir" fetch -q --depth 1 origin "$rev"
  git -C "$dir" checkout -q FETCH_HEAD
  git -C "$dir" submodule -q update --init --depth 1 --recursive 2>/dev/null || true
}

# 1. System packages (SDL2 for the zelda3 build, procps for REA)
if ! command -v sdl2-config >/dev/null || ! command -v ps >/dev/null; then
  log "installing apt packages"
  if command -v apt-get >/dev/null; then
    SUDO=""; [ "$(id -u)" = 0 ] || SUDO=sudo
    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq libsdl2-dev procps unzip >/dev/null
  fi
fi
python3 -c "import PIL, yaml" 2>/dev/null || python3 -m pip install -q --break-system-packages Pillow PyYAML 2>/dev/null || python3 -m pip install -q Pillow PyYAML

# 2. Ghidra + 65816 processor module
if [ ! -x "$GHIDRA_DIR/support/analyzeHeadless" ]; then
  log "downloading Ghidra $GHIDRA_VER"
  zip="$RE_HOME/dl/ghidra_${GHIDRA_VER}.zip"
  curl -fsSL -o "$zip" "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VER}_build/ghidra_${GHIDRA_VER}_PUBLIC_${GHIDRA_DATE}.zip"
  echo "$GHIDRA_SHA256  $zip" | sha256sum -c - >/dev/null
  unzip -q -o "$zip" -d "$RE_HOME" && rm -f "$zip"
fi
clone_at achan1989/ghidra-65816 "$SRC/ghidra-65816" "$G65816_REV"
proc="$GHIDRA_DIR/Ghidra/Processors/65816"
if [ ! -f "$proc/data/languages/65816.slaspec" ]; then
  cp -r "$SRC/ghidra-65816" "$proc" && rm -rf "$proc/.git"
fi
# Ghidra 12 rejects the module's old prototype "type" attribute.
sed -i 's/ type="unknown"//' "$proc/data/languages/65816.cspec"

# 3. asar assembler
if [ ! -x "$RE_HOME/bin/asar" ]; then
  log "building asar"
  clone_at RPGHacker/asar "$SRC/asar" "$ASAR_REV"
  cmake -S "$SRC/asar/src" -B "$SRC/asar/build" -DCMAKE_BUILD_TYPE=Release >>"$BUILD_LOG" 2>&1
  cmake --build "$SRC/asar/build" -j"$(nproc)" >>"$BUILD_LOG" 2>&1
  cp "$SRC/asar/build/asar/bin/asar" "$RE_HOME/bin/asar"
fi

# 4. Community reference work
clone_at spannerisms/jpdasm "$SRC/jpdasm" "$JPDASM_REV"
clone_at snesrev/zelda3 "$SRC/zelda3" "$ZELDA3_REV"
if [ ! -x "$SRC/zelda3/zelda3" ]; then
  log "building zelda3 (C reimplementation)"
  (cd "$SRC/zelda3" && CFLAGS=-O2 make -j"$(nproc)" zelda3 >>"$BUILD_LOG" 2>&1)
fi

# 5. REA (Reverse Engineer Anything) CLI + MCP server
if [ "$(rea --version 2>/dev/null || true)" != "$REA_VERSION" ]; then
  log "installing rea-agents@$REA_VERSION"
  npm install -g -s "rea-agents@$REA_VERSION" >/dev/null
fi

# 6. Your ROM: if roms/zelda3.sfc is missing, look for a matching upload in the
#    project's shared files (which outlive each session) and strip any copier header.
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
ROM="$REPO_DIR/roms/zelda3.sfc"
US_SHA1=6d4f10a8b10e10dbe624cb23cf03b88bb8252973
if [ ! -f "$ROM" ] && [ -d /mnt/project-files/uploads ]; then
  while IFS= read -r f; do
    size=$(stat -c %s "$f")
    skip=$(( size % 0x8000 == 512 ? 512 : 0 ))
    if [ "$(tail -c +$((skip + 1)) "$f" | sha1sum | cut -d' ' -f1)" = "$US_SHA1" ]; then
      tail -c +$((skip + 1)) "$f" > "$ROM"; log "found your US ROM in project files: $f"; break
    fi
  done < <(find /mnt/project-files/uploads/ -type f \( -size 1048576c -o -size 1049088c \) 2>/dev/null)
fi
if [ -f "$ROM" ] && [ ! -f "$SRC/zelda3/zelda3_assets.dat" ]; then
  log "extracting zelda3 assets from your ROM"
  cp "$ROM" "$SRC/zelda3/zelda3.sfc"
  (cd "$SRC/zelda3" && python3 assets/restool.py --extract-from-rom >>"$BUILD_LOG" 2>&1)
fi

# 7. Environment for this and later shells
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export RE_HOME=$RE_HOME"
    echo "export GHIDRA_INSTALL_DIR=$GHIDRA_DIR"
    echo "export PATH=$RE_HOME/bin:$GHIDRA_DIR/support:\$PATH"
  } >> "$CLAUDE_ENV_FILE"
fi
log "done: Ghidra $GHIDRA_VER (+65816), asar, zelda3, jpdasm, rea $REA_VERSION in $RE_HOME"
