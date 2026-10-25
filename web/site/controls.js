// Keyboard and gamepad controls for both backends (zelda3 and the SNES
// emulator), with a picture of an SNES pad the player clicks to rebind a button.
//
// Defaults come from web/keymap.ini. A player's own bindings are kept in this
// browser (localStorage). The game asks for the held buttons once per frame
// with buttons(), as an SNES joypad bit mask.

// SNES buttons, in keymap.ini's "Controls" order, with their joypad bit
// (the order zelda3 and LakeSnes both use: bit 0 B, 1 Y, 2 Select, 3 Start,
// 4-7 Up Down Left Right, 8 A, 9 X, 10 L, 11 R).
export const BUTTONS = [
  { id: 'up', name: 'Up', bit: 4 },
  { id: 'down', name: 'Down', bit: 5 },
  { id: 'left', name: 'Left', bit: 6 },
  { id: 'right', name: 'Right', bit: 7 },
  { id: 'select', name: 'Select', bit: 2 },
  { id: 'start', name: 'Start', bit: 3 },
  { id: 'a', name: 'A', bit: 8 },
  { id: 'b', name: 'B', bit: 0 },
  { id: 'x', name: 'X', bit: 9 },
  { id: 'y', name: 'Y', bit: 1 },
  { id: 'l', name: 'L', bit: 10 },
  { id: 'r', name: 'R', bit: 11 },
];
const BY_ID = Object.fromEntries(BUTTONS.map((b) => [b.id, b]));

// Standard gamepad layout (https://w3c.github.io/gamepad/#remapping): face
// buttons by position, like an SNES pad.
const DEFAULT_PAD = { b: 0, a: 1, y: 2, x: 3, l: 4, r: 5, select: 8, start: 9, up: 12, down: 13, left: 14, right: 15 };
const PAD_NAMES = ['Bottom', 'Right', 'Left', 'Top', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start',
  'L3', 'R3', '↑', '↓', '←', '→', 'Home'];
const padName = (i) => PAD_NAMES[i] ?? 'Button ' + i;

// Keys the page itself uses: turbo and save states.
const RESERVED = /^(Tab|F([1-9]|1[0-2]))$/;

const STORAGE_KEY = 'lttp-controls';
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } };

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

// Short label for a KeyboardEvent.code, to fit on a button.
const CODE_LABELS = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Enter', Space: 'Space',
  ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
  AltLeft: 'L Alt', AltRight: 'R Alt', Backspace: 'Bksp', Comma: ',', Period: '.', Slash: '/',
  Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
  Backquote: '`', Backslash: '\\', CapsLock: 'Caps', MetaLeft: 'Meta', MetaRight: 'Meta',
};
export function codeLabel(code) {
  if (!code) return '—';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return CODE_LABELS[code] ?? code;
}

// keymap.ini [KeyMap] Controls lines: the first is the main layout, later
// lines add backup keys (arrows, Enter, Right Shift) for the first buttons.
export function parseKeymap(text) {
  const main = {}, extra = new Map();
  let section = '', line = 0;
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (s.startsWith('[')) { section = s.toLowerCase(); continue; }
    const m = /^controls\s*=\s*(.*)$/i.exec(s);
    if (section !== '[keymap]' || !m) continue;
    m[1].split(',').forEach((name, i) => {
      const code = sdlKeyToCode(name);
      if (!code || i >= BUTTONS.length) return;
      if (line === 0) main[BUTTONS[i].id] = code;
      else if (!extra.has(code)) extra.set(code, BUTTONS[i].id);
    });
    line++;
  }
  return { main, extra };
}

const editable = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function createControls({ keymapText, root }) {
  const defaults = parseKeymap(keymapText);
  let keys = {}, pad = {};   // button id -> KeyboardEvent.code / gamepad button index
  let byCode = new Map();    // KeyboardEvent.code -> button id, main keys then backups
  function load() {
    const saved = lsGet(STORAGE_KEY) || {};
    keys = { ...defaults.main, ...saved.keys };
    pad = { ...DEFAULT_PAD, ...saved.pad };
    reindex();
  }
  function reindex() {
    byCode = new Map();
    for (const [id, code] of Object.entries(keys)) if (code) byCode.set(code, id);
    for (const [code, id] of defaults.extra) if (!byCode.has(code)) byCode.set(code, id);
  }
  const save = () => lsSet(STORAGE_KEY, { keys, pad });

  // --- Input ----------------------------------------------------------------
  let active = false;        // a game is running: bound keys go to it
  const held = new Set();    // codes held down
  let latched = 0;           // pressed since the last buttons() call, so short taps count

  function onKey(e, down) {
    if (listening && listening.mode === 'keys') {
      if (!down) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Escape') { stopListening(); return; }
      if (RESERVED.test(e.code)) { hint(`${e.code} is for turbo and save states. Pick another key.`); return; }
      bindKey(listening.id, e.code);
      return;
    }
    if (!active || editable(e.target)) return;
    const id = byCode.get(e.code);
    if (!id) return;
    // Keep bound keys away from the page and the game's own key handling.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (down) { held.add(e.code); latched |= 1 << BY_ID[id].bit; } else held.delete(e.code);
  }
  // Capture phase on window runs before the game's listeners.
  addEventListener('keydown', (e) => onKey(e, true), true);
  addEventListener('keyup', (e) => onKey(e, false), true);
  addEventListener('blur', () => held.clear());

  function padButtons() {
    let b = 0;
    for (const p of navigator.getGamepads?.() ?? []) {
      if (!p) continue;
      for (const btn of BUTTONS) if (p.buttons[pad[btn.id]]?.pressed) b |= 1 << btn.bit;
      const [x = 0, y = 0] = p.axes;   // left stick always moves
      if (x < -0.5) b |= 1 << 6; else if (x > 0.5) b |= 1 << 7;
      if (y < -0.5) b |= 1 << 4; else if (y > 0.5) b |= 1 << 5;
    }
    return b;
  }

  // SNES joypad bits held now (or tapped since the last call).
  function buttons() {
    let b = latched;
    latched = 0;
    for (const code of held) {
      const id = byCode.get(code);
      if (id) b |= 1 << BY_ID[id].bit;
    }
    return b | padButtons();
  }

  // --- Rebinding -------------------------------------------------------------
  let listening = null;   // { id, mode }
  let mode = 'keys';      // which bindings the picture shows: 'keys' or 'pad'

  function bindKey(id, code) {
    // A key does one thing: the button that had it takes this button's old key.
    const other = Object.keys(keys).find((k) => k !== id && keys[k] === code);
    if (other) keys[other] = keys[id];
    keys[id] = code;
    finishBind(id, other, codeLabel(code));
  }
  function bindPad(id, index) {
    const other = Object.keys(pad).find((k) => k !== id && pad[k] === index);
    if (other) pad[other] = pad[id];
    pad[id] = index;
    finishBind(id, other, padName(index));
  }
  function finishBind(id, other, label) {
    reindex();
    save();
    listening = null;
    render();
    hint(`${BY_ID[id].name} is now ${label}.` + (other ? ` ${BY_ID[other].name} took its old one.` : ''));
  }

  function startListening(id) {
    listening = { id, mode };
    render();
    if (mode === 'keys') {
      hint(`Press a key for ${BY_ID[id].name}. Esc cancels.`);
      return;
    }
    hint(`Press a gamepad button for ${BY_ID[id].name}. Esc or click elsewhere cancels.`);
    // Wait for a button that wasn't already down when we started.
    const before = new Set();
    for (const p of navigator.getGamepads?.() ?? []) p?.buttons.forEach((b, i) => b.pressed && before.add(p.index + ':' + i));
    const me = listening;
    const poll = () => {
      if (listening !== me) return;
      for (const p of navigator.getGamepads?.() ?? []) {
        if (!p) continue;
        for (let i = 0; i < p.buttons.length; i++) {
          const key = p.index + ':' + i;
          if (p.buttons[i].pressed && !before.has(key)) { bindPad(id, i); return; }
          if (!p.buttons[i].pressed) before.delete(key);
        }
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }
  function stopListening() {
    if (!listening) return;
    listening = null;
    render();
    hint('');
  }

  // --- Picture ---------------------------------------------------------------
  root.innerHTML = `
    <div class="pad-tabs" role="tablist" aria-label="Show bindings for">
      <button role="tab" data-mode="keys" class="pad-tab">Keyboard</button>
      <button role="tab" data-mode="pad" class="pad-tab">Gamepad</button>
    </div>
    ${PAD_SVG}
    <p class="pad-hint" aria-live="polite"></p>
    <div class="pad-actions">
      <span class="muted pad-note"></span>
      <button class="link pad-reset">Reset to defaults</button>
    </div>`;
  const hintEl = root.querySelector('.pad-hint');
  const defaultHint = () => (mode === 'keys'
    ? 'Click a button on the pad, then press the key you want for it.'
    : 'Click a button on the pad, then press the gamepad button you want for it.');
  function hint(text) { hintEl.textContent = text || defaultHint(); }

  function render() {
    for (const tab of root.querySelectorAll('.pad-tab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
    }
    for (const g of root.querySelectorAll('.pad-btn')) {
      const id = g.dataset.btn;
      const label = listening?.id === id ? '?' : mode === 'keys' ? codeLabel(keys[id]) : padName(pad[id]);
      const text = g.querySelector('.key');
      text.textContent = label;
      text.classList.toggle('long', label.length > 3);
      text.classList.toggle('xlong', label.length > 5);
      g.classList.toggle('listening', listening?.id === id);
      g.setAttribute('aria-label', `${BY_ID[id].name}: ${label}. Press to change.`);
    }
    root.querySelector('.pad-note').textContent = mode === 'keys'
      ? 'Arrow keys, Enter and Right Shift also work unless you give them to another button.'
      : 'The left stick always moves. Saved in this browser.';
  }

  for (const g of root.querySelectorAll('.pad-btn')) {
    g.addEventListener('click', (e) => { e.stopPropagation(); startListening(g.dataset.btn); });
    g.addEventListener('keydown', (e) => {
      if (listening || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      startListening(g.dataset.btn);
    });
  }
  for (const tab of root.querySelectorAll('.pad-tab')) {
    tab.addEventListener('click', () => { mode = tab.dataset.mode; listening = null; render(); hint(''); });
  }
  root.querySelector('.pad-reset').addEventListener('click', () => {
    lsDel(STORAGE_KEY);
    listening = null;
    load();
    render();
    hint('Back to the default controls.');
  });
  document.addEventListener('click', (e) => { if (!root.contains(e.target)) stopListening(); });
  addEventListener('keydown', (e) => { if (listening?.mode === 'pad' && e.code === 'Escape') stopListening(); }, true);

  load();
  render();
  hint('');

  return {
    buttons,
    setActive(on) { active = on; held.clear(); },
    bindings: () => ({ keys: { ...keys }, pad: { ...pad } }),
  };
}

// An SNES-style pad, drawn here (not Nintendo artwork). Each .pad-btn is a
// button the player can click to rebind; its .key text shows the binding.
const btn = (id, shape, tx, ty, extra = '') =>
  `<g class="pad-btn" data-btn="${id}" tabindex="0" role="button"${extra}>${shape}` +
  `<text class="key" x="${tx}" y="${ty}"></text></g>`;
const face = (id, cx, cy, color, letter, lx, ly) =>
  btn(id, `<circle cx="${cx}" cy="${cy}" r="27" fill="${color}" class="face"/>`, cx, cy, ` style="--face:${color}"`) +
  `<text class="letter" x="${lx}" y="${ly}">${letter}</text>`;

const PAD_SVG = `
<svg class="snes-pad" viewBox="0 0 640 300" role="group" aria-label="SNES controller. Click a button to change its key.">
  ${btn('l', '<rect x="60" y="14" width="200" height="70" rx="30" class="shoulder"/>', 140, 38)}
  ${btn('r', '<rect x="380" y="14" width="200" height="70" rx="30" class="shoulder"/>', 500, 38)}
  <text class="letter" x="88" y="38">L</text>
  <text class="letter" x="552" y="38">R</text>
  <path class="body" d="M165 52 H475 A114 114 0 0 1 475 280 H165 A114 114 0 0 1 165 52 Z"/>
  <circle class="well" cx="165" cy="166" r="84"/>
  <path class="dpad-base" d="M143 100 h44 v44 h44 v44 h-44 v44 h-44 v-44 h-44 v-44 h44 Z"/>
  ${btn('up', '<rect x="143" y="100" width="44" height="46" class="arm"/>', 165, 124)}
  ${btn('down', '<rect x="143" y="186" width="44" height="46" class="arm"/>', 165, 210)}
  ${btn('left', '<rect x="99" y="144" width="46" height="44" class="arm"/>', 122, 167)}
  ${btn('right', '<rect x="185" y="144" width="46" height="44" class="arm"/>', 208, 167)}
  ${btn('select', '<rect x="262" y="178" width="58" height="22" rx="11" class="pill" transform="rotate(-25 291 189)"/>', 291, 190)}
  ${btn('start', '<rect x="330" y="178" width="58" height="22" rx="11" class="pill" transform="rotate(-25 359 189)"/>', 359, 190)}
  <text class="caption" x="291" y="226">SELECT</text>
  <text class="caption" x="359" y="226">START</text>
  <rect class="well" x="382" y="106" width="130" height="62" rx="31" transform="rotate(-45 447 137)"/>
  <rect class="well" x="440" y="164" width="130" height="62" rx="31" transform="rotate(-45 505 195)"/>
  ${face('x', 476, 108, '#3d6fd6', 'X', 516, 92)}
  ${face('a', 534, 166, '#d6403f', 'A', 574, 170)}
  ${face('b', 476, 224, '#e9c43a', 'B', 476, 268)}
  ${face('y', 418, 166, '#2f9e55', 'Y', 400, 210)}
</svg>`;
