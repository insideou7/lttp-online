#!/usr/bin/env bash
# Builds the browser client into web/dist/.
#
# What it does:
#   1. Fetches snesrev/zelda3 at a pinned commit and applies web/patches/.
#   2. Compiles the game to WebAssembly with Emscripten (SDL2 port).
#   3. Bundles Pyodide (Python in WebAssembly) and zelda3's asset tool, so the
#      page can turn the player's own ROM into game assets in their browser.
#
# No ROM or extracted asset is downloaded or written to dist/. The page asks
# the player for their ROM at run time.
#
# Requires: emsdk on PATH (emcc), git, curl, tar with bzip2.
# Usage: web/build.sh            (EMSDK=/path/to/emsdk to source emsdk_env.sh)
#        SYNC_URL=wss://host/sync web/build.sh   when the multiplayer sync server
#        isn't at /sync on the same host as the page (see docs/multiplayer.md)
set -euo pipefail

ZELDA3_REPO=https://github.com/snesrev/zelda3
ZELDA3_COMMIT=45a149d8b4bb8098f53d1009f76e76e7d8b79bbf
SDL2_TAG=release-2.32.10   # the version Emscripten's sdl2 port uses
PYODIDE_VERSION=0.27.7
PYODIDE_WHEELS=(
  "pillow-10.2.0-cp312-cp312-pyodide_2024_0_wasm32.whl 43eab147a9355385a99eeac18fb577d4af2fe4bd0bbd23d3ba3ddb92e72c2815"
  "pyyaml-6.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl 444d034ede13ca0a2961a1215838fb7d4cf6fa98ba7fe5e2a09e5063180af2bf"
)

WEB="$(cd "$(dirname "$0")" && pwd)"
CACHE="$WEB/.cache"
DIST="$WEB/dist"
SRC="$CACHE/zelda3"
mkdir -p "$CACHE" "$DIST"

if ! command -v emcc >/dev/null; then
  if [ -n "${EMSDK:-}" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
    # shellcheck disable=SC1091
    EMSDK_QUIET=1 source "$EMSDK/emsdk_env.sh" >/dev/null
  else
    echo "emcc not found. Install emsdk and set EMSDK=/path/to/emsdk." >&2
    exit 1
  fi
fi

# 1. zelda3 source, patched
if [ ! -d "$SRC/.git" ]; then
  git clone --quiet "$ZELDA3_REPO" "$SRC"
fi
git -C "$SRC" fetch --quiet origin "$ZELDA3_COMMIT" 2>/dev/null || true
git -C "$SRC" checkout --quiet --force "$ZELDA3_COMMIT"
git -C "$SRC" clean --quiet -fdx
for p in "$WEB"/patches/*.patch; do
  git -C "$SRC" apply --whitespace=nowarn "$p"
done

# Emscripten downloads its SDL2 port from a GitHub archive URL, which some
# networks block. A git checkout of the same tag works as a local port.
if [ ! -d "$CACHE/SDL2/.git" ]; then
  git clone --quiet --depth 1 -b "$SDL2_TAG" https://github.com/libsdl-org/SDL "$CACHE/SDL2"
fi
export EMCC_LOCAL_PORTS="sdl2=$CACHE/SDL2"

# 2. Compile
OBJ="$CACHE/obj"
mkdir -p "$OBJ"
CFLAGS=(-O3 -I "$SRC" -sUSE_SDL=2 -DSYSTEM_VOLUME_MIXER_AVAILABLE=0 -DNDEBUG -w)
SRCS=("$SRC"/src/*.c "$SRC"/snes/*.c "$SRC"/third_party/opus-1.3.1-stripped/opus_decoder_amalgam.c "$WEB/src/web_api.c")
OBJS=()
pids=()
for f in "${SRCS[@]}"; do
  # opengl.c needs desktop GL; the web build uses the SDL renderer.
  case "$f" in */src/opengl.c|*/src/glsl_shader.c) continue ;; esac
  o="$OBJ/$(basename "${f%.c}").o"
  OBJS+=("$o")
  emcc -c "${CFLAGS[@]}" "$f" -o "$o" &
  pids+=($!)
  if [ "${#pids[@]}" -ge "$(nproc)" ]; then wait "${pids[0]}"; pids=("${pids[@]:1}"); fi
done
for p in "${pids[@]}"; do wait "$p"; done

emcc "${OBJS[@]}" -o "$DIST/zelda3.js" \
  -O3 -sUSE_SDL=2 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createZelda3 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sFORCE_FILESYSTEM=1 -lidbfs.js \
  -sEXPORTED_RUNTIME_METHODS=FS,IDBFS,callMain,HEAPU8 \
  -sENVIRONMENT=web

# 3. Asset tool: zelda3's own Python scripts (MIT) plus Pyodide to run them.
rm -rf "$DIST/restool"
mkdir -p "$DIST/restool/assets" "$DIST/restool/other"
cp "$SRC"/assets/*.py "$SRC"/assets/palette_usage.bin "$DIST/restool/assets/"
cp "$SRC"/other/3x5_font.png "$DIST/restool/other/"
(cd "$DIST/restool" && find . -type f | sed 's#^\./##' | sort) > "$DIST/restool/files.txt"

PYO="$CACHE/pyodide-$PYODIDE_VERSION"
if [ ! -f "$PYO/.done" ]; then
  rm -rf "$PYO"; mkdir -p "$PYO"
  base="https://github.com/pyodide/pyodide/releases/download/$PYODIDE_VERSION"
  curl -fsSL "$base/pyodide-core-$PYODIDE_VERSION.tar.bz2" | tar xjf - -C "$PYO"
  # Wheels only ship in the full release tarball; extract just the two we need.
  names=(); for w in "${PYODIDE_WHEELS[@]}"; do names+=("pyodide/${w%% *}"); done
  curl -fsSL "$base/pyodide-$PYODIDE_VERSION.tar.bz2" | tar xjf - -C "$PYO" "${names[@]}"
  for w in "${PYODIDE_WHEELS[@]}"; do
    echo "${w##* }  $PYO/pyodide/${w%% *}" | sha256sum -c --quiet
  done
  touch "$PYO/.done"
fi
rm -rf "$DIST/pyodide"; mkdir -p "$DIST/pyodide"
cp "$PYO"/pyodide/{pyodide.mjs,pyodide.js,pyodide.asm.js,pyodide.asm.wasm,python_stdlib.zip,pyodide-lock.json} "$DIST/pyodide/"
for w in "${PYODIDE_WHEELS[@]}"; do cp "$PYO/pyodide/${w%% *}" "$DIST/pyodide/"; done

# 4. The page, plus a browser-friendly config (upstream zelda3.ini with a few changes)
cp -r "$WEB"/site/. "$DIST/"
sed -e 's/^OutputMethod = .*/OutputMethod = SDL/' \
    -e 's/^WindowScale = .*/WindowScale = 3/' \
    -e 's/^AudioSamples = .*/AudioSamples = 1024/' \
    -e 's/^Autosave = .*/Autosave = 0/' \
    "$SRC/zelda3.ini" |
  # Our keyboard layout (web/keymap.ini) replaces upstream's [KeyMap] entries of the same name
  awk 'NR == FNR { if ($0 ~ /^[A-Za-z]+ *=/) { k = $0; sub(/ *=.*/, "", k); mine[tolower(k)] = 1 } next }
       /^\[/ { sec = tolower($0); sub(/\r$/, "", sec) }
       sec == "[keymap]" && /^[A-Za-z]+ *=/ { k = $0; sub(/ *=.*/, "", k); if (tolower(k) in mine) next }
       { print }' "$WEB/keymap.ini" - > "$DIST/zelda3.ini"
printf '\n' >> "$DIST/zelda3.ini"
cat "$WEB/keymap.ini" >> "$DIST/zelda3.ini"
printf '{"zelda3": "%s", "sync": "%s"}\n' "$ZELDA3_COMMIT" "${SYNC_URL:-}" > "$DIST/build.json"
cp "$SRC/LICENSE.txt" "$DIST/ZELDA3_LICENSE.txt"
echo "Built $DIST. Serve it with: python3 -m http.server -d $DIST 8080"
