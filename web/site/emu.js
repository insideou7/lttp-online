// Runs a ROM on the SNES emulator core (LakeSnes compiled to WebAssembly, see
// web/src/emu_api.c): picture, sound, keyboard and gamepad, battery saves and
// save states. Used for randomizer seeds, which zelda3 can't play.

const FPS = 60.0988;                 // NTSC SNES frame rate
const FRAME_MS = 1000 / FPS;
const W = 512, H = 448;              // the core doubles pixels; 224 lines start at line 16
const SRAM_CHECK_FRAMES = 60;

// SNES buttons as LakeSnes bit numbers, in web/keymap.ini's "Controls" order:
// Up, Down, Left, Right, Select, Start, A, B, X, Y, L, R.
const CONTROL_BITS = [4, 5, 6, 7, 2, 3, 8, 0, 9, 1, 10, 11];

// SDL key names (as in keymap.ini) to KeyboardEvent.code.
const SDL_KEY_CODES = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  return: 'Enter', enter: 'Enter', space: 'Space', tab: 'Tab', backspace: 'Backspace', escape: 'Escape',
  'right shift': 'ShiftRight', 'left shift': 'ShiftLeft', 'right ctrl': 'ControlRight', 'left ctrl': 'ControlLeft',
  'right alt': 'AltRight', 'left alt': 'AltLeft', ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon',
  "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', '`': 'Backquote',
  '\\': 'Backslash',
};
function sdlKeyToCode(name) {
  const k = name.trim().toLowerCase();
  if (/^[a-z]$/.test(k)) return 'Key' + k.toUpperCase();
  if (/^[0-9]$/.test(k)) return 'Digit' + k;
  if (/^f([1-9]|1[0-2])$/.test(k)) return k.toUpperCase();
  if (k.startsWith('keypad ')) return 'Numpad' + k.slice(7);
  return SDL_KEY_CODES[k] ?? null;
}

// KeyboardEvent.code -> button bit, from the [KeyMap] Controls lines of
// keymap.ini (the same file the zelda3 build uses).
export function parseKeymap(text) {
  const map = new Map();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) { section = line.toLowerCase(); continue; }
    const m = /^controls\s*=\s*(.*)$/i.exec(line);
    if (section !== '[keymap]' || !m) continue;
    m[1].split(',').forEach((name, i) => {
      const code = sdlKeyToCode(name);
      if (code && i < CONTROL_BITS.length && !map.has(code)) map.set(code, CONTROL_BITS[i]);
    });
  }
  return map;
}

// Standard gamepad layout: face buttons by position, like a SNES pad.
const PAD_BITS = [[0, 0], [1, 8], [2, 1], [3, 9], [4, 10], [5, 11], [8, 2], [9, 3], [12, 4], [13, 5], [14, 6], [15, 7]];
function gamepadButtons() {
  let b = 0;
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (!pad) continue;
    for (const [i, bit] of PAD_BITS) if (pad.buttons[i]?.pressed) b |= 1 << bit;
    const [x = 0, y = 0] = pad.axes;
    if (x < -0.5) b |= 1 << 6; else if (x > 0.5) b |= 1 << 7;
    if (y < -0.5) b |= 1 << 4; else if (y > 0.5) b |= 1 << 5;
  }
  return b;
}

// Sound: an AudioWorklet playing stereo frames queued from the main thread.
const WORKLET = `
class SnesAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(16384); this.r = 0; this.w = 0;
    this.port.onmessage = (e) => {
      const d = e.data, n = this.buf.length;
      if ((this.w - this.r + n) % n + d.length >= n - 2) return;   // full: drop
      for (let i = 0; i < d.length; i++) { this.buf[this.w] = d[i]; this.w = (this.w + 1) % n; }
    };
  }
  process(_, outputs) {
    const [l, r] = outputs[0], n = this.buf.length;
    for (let i = 0; i < l.length; i++) {
      if (this.r === this.w) { l[i] = r[i] = 0; continue; }
      l[i] = this.buf[this.r]; r[i] = this.buf[this.r + 1]; this.r = (this.r + 2) % n;
    }
    this.port.postMessage((this.w - this.r + n) % n / 2);
    return true;
  }
}
registerProcessor('snes-audio', SnesAudio);
`;

async function startAudio() {
  try {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'snes-audio', { outputChannelCount: [2] });
    node.connect(ctx.destination);
    const audio = { ctx, node, queued: 0 };
    node.port.onmessage = (e) => { audio.queued = e.data; };
    // Browsers start audio only after a user gesture; Play was one, but resume
    // on the next key press too in case it wasn't counted.
    const resume = () => ctx.state !== 'running' && ctx.resume();
    addEventListener('keydown', resume);
    addEventListener('pointerdown', resume);
    return audio;
  } catch (e) {
    console.warn('No sound:', e);
    return null;
  }
}

// store: { get(key), set(key, value) } (the page's IndexedDB), for saves.
// gameId keys this game's saves, so each seed has its own save files.
export async function startEmulator({ createSnes, canvas, rom, keymap, store, gameId, onError = () => {} }) {
  const core = await createSnes();
  const romPtr = core._malloc(rom.length);
  core.HEAPU8.set(rom, romPtr);
  const loaded = core._emu_load(romPtr, rom.length);
  core._free(romPtr);
  if (!loaded) throw new Error('The emulator could not load this ROM.');

  // Battery saves (the game's three files).
  const sramKey = 'sram:' + gameId;
  const sramSize = core._emu_sram_size();
  const sramView = () => core.HEAPU8.subarray(core._emu_sram(), core._emu_sram() + sramSize);
  if (sramSize) {
    const saved = await store.get(sramKey);
    if (saved && saved.length === sramSize) sramView().set(saved);
  }
  let lastSram = sramSize ? sramView().slice() : null;
  async function saveSram() {
    if (!sramSize) return;
    const now = sramView();
    if (lastSram.every((b, i) => b === now[i])) return;
    lastSram = now.slice();
    try { await store.set(sramKey, lastSram); } catch (e) { console.warn('Saving failed', e); }
  }

  const ctx2d = canvas.getContext('2d', { alpha: false });
  canvas.width = W;
  canvas.height = H;
  const audio = await startAudio();
  const keys = parseKeymap(keymap);
  let held = 0, turbo = false;
  const frameHooks = new Set();

  const editable = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  async function onKey(e, down) {
    if (editable(e.target)) return;
    const bit = keys.get(e.code);
    if (bit !== undefined) {
      e.preventDefault();
      if (down) held |= 1 << bit; else held &= ~(1 << bit);
      return;
    }
    if (e.code === 'Tab') { e.preventDefault(); turbo = down; return; }
    // Save states like the zelda3 build: Shift+F1-F10 saves, F1-F10 loads.
    const slot = /^F(\d+)$/.exec(e.code)?.[1];
    if (down && slot && slot <= 10) {
      e.preventDefault();
      if (e.repeat) return;
      const key = `state:${gameId}:${slot}`;
      if (e.shiftKey) {
        await store.set(key, saveState());
        emu.onMessage?.(`Saved state ${slot}`);
      } else {
        const s = await store.get(key);
        emu.onMessage?.(s && loadState(s) ? `Loaded state ${slot}` : `No saved state ${slot}`);
      }
    }
  }
  addEventListener('keydown', (e) => onKey(e, true));
  addEventListener('keyup', (e) => onKey(e, false));
  addEventListener('blur', () => { held = 0; turbo = false; });

  function saveState() {
    const sizePtr = core._malloc(4);
    const ptr = core._emu_state_save(sizePtr);
    const size = core.HEAP32[sizePtr >> 2];
    const data = core.HEAPU8.slice(ptr, ptr + size);
    core._free(ptr);
    core._free(sizePtr);
    return data;
  }
  function loadState(data) {
    const ptr = core._malloc(data.length);
    core.HEAPU8.set(data, ptr);
    const ok = core._emu_state_load(ptr, data.length);
    core._free(ptr);
    return !!ok;
  }

  function runFrame() {
    core._emu_frame(held | gamepadButtons());
    for (const cb of frameHooks) {
      try { cb(); } catch (e) { console.warn('frame hook', e); }
    }
    if (audio) {
      // Aim for about 3 frames of queued sound: a little more or less per
      // frame keeps the queue there without audible pitch changes.
      const per = audio.ctx.sampleRate / FPS;
      const target = per * 3;
      const n = Math.max(1, Math.min(2048, Math.round(per + (target - audio.queued) * 0.05)));
      const ptr = core._emu_samples(n) >> 1;
      const out = new Float32Array(n * 2);
      for (let i = 0; i < n * 2; i++) out[i] = core.HEAP16[ptr + i] / 32768;
      audio.node.port.postMessage(out, [out.buffer]);
      audio.queued += n;
    }
  }

  function draw() {
    const ptr = core._emu_pixels() + 16 * 2048;
    const img = new ImageData(new Uint8ClampedArray(core.HEAPU8.buffer, ptr, W * H * 4).slice(), W, H);
    ctx2d.putImageData(img, 0, 0);
  }

  let next = 0, frames = 0, stopped = false;
  function loop(now) {
    if (stopped) return;
    requestAnimationFrame(loop);
    if (!next || now - next > 250) next = now;   // first frame, or back from a background tab
    let ran = 0;
    if (turbo) {
      for (; ran < 6; ran++) runFrame();
      next = now + FRAME_MS;
    } else {
      while (now >= next && ran < 4) { runFrame(); next += FRAME_MS; ran++; }
    }
    if (!ran) return;
    draw();
    frames += ran;
    if (frames >= SRAM_CHECK_FRAMES) { frames = 0; saveSram(); }
  }
  try {
    requestAnimationFrame(loop);
  } catch (e) { onError(e.message); }
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSram(); });

  const emu = {
    core,
    rom,
    ram: () => core._emu_ram(),
    // Runs a game subroutine between frames (see emu_call in emu_api.c).
    call: (adr) => !!core._emu_call(adr),
    onFrame: (cb) => { frameHooks.add(cb); return () => frameHooks.delete(cb); },
    onMessage: null,
    saveState,
    loadState,
    stop() { stopped = true; saveSram(); audio?.ctx.close(); },
  };
  return emu;
}
