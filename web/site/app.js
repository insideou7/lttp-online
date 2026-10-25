// LTTP Online page logic: get assets from the player's ROM (once), then run the game.
// The US ROM runs on zelda3 (a C reimplementation); any other ROM based on the
// game, such as a randomizer seed, runs on an SNES emulator core (emu.js).
import { SyncClient, resolveSyncUrl } from './sync/client.js';
import { zelda3Backend } from './sync/zelda3-backend.js';
import { snesBackend } from './sync/snes-backend.js';
import { isRoomCode, newRoomCode, VANILLA_GAME } from './sync/room.js';
import { identifyRom, stripHeader } from './rom-info.js';
import { askRoomSeed, makeSeedPatch, rebuildSeed } from './sync/seed-share.js';
import { startGhosts } from './ghosts.js';
import { createControls } from './controls.js';

const GAME_DIR = '/zelda3';
const SEED_KEY = 'seed-rom';   // the randomizer ROM, kept in this browser only
// Original copies of the game (rom-info.js BASE_ROMS) by SHA-1, also kept in
// this browser only: a room's seed arrives as a patch and is rebuilt from one.
const BASES_KEY = 'base-roms';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

// --- Tiny IndexedDB key/value store for the extracted assets -------------
// The assets come from the player's own ROM and stay in their browser.
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lttp-online', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kv(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const kvGet = (k) => kv('readonly', (s) => s.get(k));
const kvSet = (k, v) => kv('readwrite', (s) => s.put(v, k));
const kvDel = (k) => kv('readwrite', (s) => s.delete(k));

// Assets are tied to the zelda3 version the game was built from.
// build.json may also name the sync server ("sync"), for hosts where it isn't
// on the page's own origin.
let assetsKey = 'assets';
// Each deploy gets a new build id. Game files are requested with ?v=<id> so the
// browser never runs a stale cached copy after an update.
let ver = '';
let buildInfo = {};
async function loadBuildInfo() {
  try {
    const info = buildInfo = await (await fetch('build.json', { cache: 'no-cache' })).json();
    assetsKey = 'assets-' + info.zelda3;
    if (info.build) ver = '?v=' + info.build;
  } catch { /* keep defaults */ }
}

// --- ROM -> assets ---------------------------------------------------------
async function romFromFile(file) {
  const rom = stripHeader(new Uint8Array(await file.arrayBuffer()));
  return { rom, info: await identifyRom(rom) };
}

function extractAssets(rom) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('extract-worker.js' + ver, import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.progress) setStatus(e.data.progress);
      else {
        worker.terminate();
        if (e.data.assets) resolve(e.data.assets);
        else reject(new Error(e.data.error || 'Asset extraction failed'));
      }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Worker failed')); };
    worker.postMessage({ rom }, [rom.buffer]);
  });
}

// --- Original ROMs and shared seeds --------------------------------------------
async function getBases() {
  return Object.values((await kvGet(BASES_KEY)) ?? {});
}
async function addBase(rom, info) {
  const bases = (await kvGet(BASES_KEY)) ?? {};
  bases[info.sha1] = { sha1: info.sha1, label: info.base, rom: rom.slice() };
  await kvSet(BASES_KEY, bases);
}

// The seed as a patch against the player's original ROM, for friends who join
// without it (made once, then kept with the seed).
async function seedPatchFor(seed) {
  if (!seed.patch) {
    seed.patch = await makeSeedPatch(seed.rom, seed.info, await getBases());
    kvSet(SEED_KEY, seed).catch(() => {});
  }
  return seed.patch;
}

// When the page is opened with a room code: find out what the room plays and,
// if it's a seed this browser doesn't have, get it from a player in the room.
let roomSeedTimer = 0;
let roomSeedRun = 0;
let pendingPatch = null;   // a room's seed waiting for the right original ROM
function showRoomSeed(text, isError = false) {
  const el = $('room-seed');
  el.hidden = !text;
  el.textContent = text;
  el.classList.toggle('error', isError);
}
function stopRoomSeed() {
  clearTimeout(roomSeedTimer);
  roomSeedRun++;
  showRoomSeed('');
}
async function checkRoomSeed() {
  clearTimeout(roomSeedTimer);
  const code = roomCode;
  if (!code || !$('game').hidden) { stopRoomSeed(); return; }
  const run = ++roomSeedRun;
  const stale = () => run !== roomSeedRun || roomCode !== code || !$('game').hidden;
  const retry = (ms) => { roomSeedTimer = setTimeout(() => { if (!stale()) checkRoomSeed(); }, ms); };
  const [assets, seed] = await Promise.all([kvGet(assetsKey), kvGet(SEED_KEY)]);
  const have = [...(assets ? [VANILLA_GAME.id] : []), ...(seed ? [seed.info.gameId] : [])];
  let res;
  try {
    res = await askRoomSeed({ url: resolveSyncUrl(buildInfo), room: code, have });
  } catch {
    if (!stale()) { showRoomSeed(''); retry(15000); }
    return;
  }
  if (stale()) return;
  if (!res.game) {
    showRoomSeed(`Nobody is playing in room ${code} yet. Press Play to start it, or wait for whoever invited you.`);
    retry(5000);
  } else if (res.game.id === VANILLA_GAME.id) {
    showRoomSeed(assets ? `Room ${code} plays the US game. Press Play to join.`
      : `Room ${code} plays the US game. Load your US ROM to join.`);
  } else if (res.have) {
    showRoomSeed(`Room ${code} plays ${res.game.label}, which you have. Press Play seed to join.`);
    $('play-seed').focus();
  } else if (res.error) {
    showRoomSeed(`Room ${code} plays ${res.game.label}. ${res.error} Trying again…`, true);
    retry(8000);
  } else {
    await useRoomPatch(res.patch, res.game, code);
  }
}
async function useRoomPatch(patch, game, code) {
  try {
    showRoomSeed(`Setting up ${game.label} from room ${code}…`);
    const { rom, info } = await rebuildSeed(patch, await getBases(), game.id);
    pendingPatch = null;
    await kvSet(SEED_KEY, { rom, info, name: `room ${code}`, patch });
    await showReady();
    showRoomSeed(`Got ${info.label} from room ${code}. Press Play seed to join.`);
    $('play-seed').focus();
  } catch (e) {
    pendingPatch = e.needsBase ? { patch, game, code } : null;
    showRoomSeed(`Room ${code} plays ${game.label}. ${e.message}`, true);
  }
}

async function onRomChosen(file) {
  const progress = $('progress');
  try {
    setStatus('Checking ROM…');
    const { rom, info } = await romFromFile(file);
    if (info.base) await addBase(rom, info);
    if (info.base && !info.vanilla) {
      // An original game other than the US one (zelda3 only plays that):
      // kept to rebuild seeds that friends share in a room.
      setStatus(`Saved your ${info.base} ROM. Randomizer seeds made from it now come to you automatically when you join a room.`);
      await showReady();
      if (pendingPatch) await useRoomPatch(pendingPatch.patch, pendingPatch.game, pendingPatch.code);
      else checkRoomSeed();
      return;
    }
    if (!info.vanilla) {
      // A randomizer seed (or other version): the emulator plays the ROM
      // itself, so keep it in this browser for next time.
      await kvSet(SEED_KEY, { rom, info, name: file.name });
      setStatus(`Loaded ${info.label}. It runs on the SNES emulator.`);
      showReady();
      return;
    }
    progress.hidden = false;
    const t0 = performance.now();
    const assets = await extractAssets(rom);
    await kvSet(assetsKey, assets);
    setStatus(`Assets ready (${((performance.now() - t0) / 1000).toFixed(0)} s).`);
    await showReady();
    if (pendingPatch) await useRoomPatch(pendingPatch.patch, pendingPatch.game, pendingPatch.code);
    else checkRoomSeed();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    progress.hidden = true;
    $('rom-input').value = '';
  }
}

// Lists the games this browser has ready: the US game (extracted assets) and
// the last randomizer seed loaded.
async function showReady() {
  const [assets, seed, bases] = await Promise.all([kvGet(assetsKey), kvGet(SEED_KEY), getBases()]);
  $('bases').hidden = !bases.length;
  $('bases-list').textContent = bases.map((b) => b.label).join(' and ');
  if (!assets && !seed) { showNeedRom(); return; }
  $('need-rom').hidden = true;
  $('ready').hidden = false;
  $('ready-vanilla').hidden = !assets;
  $('ready-seed').hidden = !seed;
  if (seed) {
    $('seed-label').textContent = seed.info.code ? seed.info.code.join(' · ') : seed.info.label;
    $('seed-title').textContent = seed.info.title ? `(${seed.info.title})` : '';
  }
  (assets ? $('play') : $('play-seed')).focus();
}

function showNeedRom() {
  $('need-rom').hidden = false;
  $('ready').hidden = true;
}

// --- Game ------------------------------------------------------------------
let game = null;  // Emscripten module once running

async function startGame() {
  const assets = await kvGet(assetsKey);
  if (!assets) { showNeedRom(); return; }
  setStatus('Starting game…');
  const [{ default: createZelda3 }, ini] = await Promise.all([
    import('./zelda3.js' + ver),
    fetch('zelda3.ini' + ver).then((r) => r.text()),
  ]);

  const canvas = $('canvas');
  let syncTimer = 0;
  const persistSaves = () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => game && game.FS.syncfs(false, (err) => {
      if (err) console.warn('Saving to browser storage failed', err);
    }), 250);
  };

  game = await createZelda3({
    canvas,
    locateFile: (path, dir) => dir + path + ver,
    print: (s) => console.log('[zelda3]', s),
    printErr: (s) => console.warn('[zelda3]', s),
    onFatalError: (msg) => { $('game-status').textContent = 'Error: ' + msg; },
    onSavesChanged: persistSaves,
    preRun: [(mod) => {
      const { FS, IDBFS } = mod;
      FS.mkdir(GAME_DIR);
      FS.writeFile(GAME_DIR + '/zelda3.ini', ini);
      FS.writeFile(GAME_DIR + '/zelda3_assets.dat', assets);
      FS.mkdir(GAME_DIR + '/saves');
      FS.mount(IDBFS, {}, GAME_DIR + '/saves');
      FS.chdir(GAME_DIR);
      // Load saves from IndexedDB before main() reads saves/sram.dat.
      mod.addRunDependency('load-saves');
      FS.syncfs(true, (err) => {
        if (err) console.warn('Could not load saves', err);
        mod.removeRunDependency('load-saves');
      });
    }],
  });

  showGame();
  game.callMain([]);
  canvas.focus();
  window.lttp = game;  // handy for debugging from the console
  // The page reads keys and gamepads (controls.js) and hands zelda3 the buttons.
  controls.setActive(true);
  const feedButtons = () => {
    game._web_set_buttons(controls.buttons());
    requestAnimationFrame(feedButtons);
  };
  feedButtons();
  startSync(zelda3Backend(game), VANILLA_GAME);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistSaves();
  });
}

function showGame() {
  stopRoomSeed();
  $('setup').hidden = true;
  $('multiplayer').hidden = true;
  $('game').hidden = false;
}

// A randomizer seed on the SNES emulator core.
async function startSeed() {
  const seed = await kvGet(SEED_KEY);
  if (!seed) { showNeedRom(); return; }
  setStatus('Starting emulator…');
  const [{ default: createSnes }, { startEmulator }] = await Promise.all([
    import('./snes.js' + ver),
    import('./emu.js' + ver),
  ]);
  const canvas = $('canvas');
  const emu = await startEmulator({
    createSnes: (opts) => createSnes({ locateFile: (path, dir) => dir + path + ver, ...opts }),
    canvas,
    rom: seed.rom,
    buttons: controls.buttons,
    store: { get: kvGet, set: kvSet },
    gameId: seed.info.gameId,
    onError: (msg) => { $('game-status').textContent = 'Error: ' + msg; },
  });
  emu.onMessage = (text) => showNotice(escapeHtml(text));
  controls.setActive(true);
  showGame();
  $('game-status').textContent = seed.info.code ? 'Seed ' + seed.info.code.join(' · ') : seed.info.label;
  canvas.focus();
  window.lttpEmu = emu;  // for debugging
  startSync(snesBackend(emu), { id: seed.info.gameId, label: seed.info.label }, () => seedPatchFor(seed));
}

// --- Multiplayer -------------------------------------------------------------
// A room is just a code in the page URL (?room=CODE): the invite link is the
// page link with the code, and the first player in a room seeds its progress.
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

let roomCode = null;
function setRoom(code) {
  roomCode = code;
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code); else url.searchParams.delete('room');
  history.replaceState(null, '', url);
  $('mp-solo').hidden = !!code;
  $('mp-room').hidden = !code;
  $('mp-leave').hidden = !code;
  if (code) {
    $('mp-room-code').textContent = code;
    $('mp-link').value = url.toString();
  }
  pendingPatch = null;
  if (ready) checkRoomSeed();
}
let ready = false;   // page set up; room checks wait until then

function showNotice(html) {
  const el = document.createElement('div');
  el.className = 'notice';
  el.innerHTML = html;
  $('notices').append(el);
  setTimeout(() => { el.style.opacity = '0'; }, 3500);
  setTimeout(() => el.remove(), 4000);
}
const escapeHtml = (t) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function startSync(backend, game, seedPatch = null) {
  if (!roomCode) return;
  const statusEl = $('mp-status');
  const label = { connecting: 'connecting…', reconnecting: 'reconnecting…', connected: '',
    unreachable: "can't reach the sync server, playing solo for now", error: 'sync error' };
  const sync = new SyncClient({
    url: resolveSyncUrl(buildInfo),
    room: roomCode,
    name: $('mp-name').value.trim() || 'Link',
    backend,
    game,
    seedPatch,
    onStatus: ({ state, detail, players, you }) => {
      let text = `Room ${roomCode}: ` + (label[state] ?? state);
      if (state === 'connected') {
        text += players.map((p) => (p.id === you ? p.name + ' (you)' : p.name)).join(', ');
      }
      if (state === 'wrong-game') {
        // Everyone in a room plays the same seed; this player loaded another.
        text = `Room ${roomCode} is playing ${detail}, but you loaded ${game.label}. ` +
          'Load the same seed to join; playing solo for now.';
        detail = '';
      }
      statusEl.textContent = text + (detail ? ` (${detail})` : '');
      statusEl.classList.toggle('error', state === 'unreachable' || state === 'error' || state === 'wrong-game');
    },
    onNotice: ({ name, what }) => showNotice(`<b>${escapeHtml(name)}</b> ${escapeHtml(what)}`),
  });
  sync.start();
  startGhosts({ gameCanvas: $('canvas'), sync, backend });
  window.lttpSync = sync;  // for debugging
}

$('mp-name').value = lsGet('lttp-name') || '';
$('mp-name').addEventListener('change', () => lsSet('lttp-name', $('mp-name').value.trim()));
$('mp-create').addEventListener('click', () => setRoom(newRoomCode()));
const joinTyped = () => {
  const code = $('mp-code').value.trim().toUpperCase();
  if (isRoomCode(code)) setRoom(code);
  else setStatus('Room codes are 4 to 12 letters and digits, like ' + newRoomCode() + '.', true);
};
$('mp-join').addEventListener('click', joinTyped);
$('mp-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinTyped(); });
$('mp-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('mp-link').value);
    $('mp-copy').textContent = 'Copied';
  } catch {
    $('mp-link').select();
  }
});
$('mp-leave').addEventListener('click', () => setRoom(null));
{
  const code = (new URL(location.href).searchParams.get('room') || '').toUpperCase();
  setRoom(isRoomCode(code) ? code : null);
}

// --- Wire up ----------------------------------------------------------------
$('rom-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) onRomChosen(file);
});
$('play').addEventListener('click', () => {
  $('play').disabled = $('play-seed').disabled = true;
  startGame().catch((err) => { setStatus(err.message, true); $('play').disabled = $('play-seed').disabled = false; });
});
$('play-seed').addEventListener('click', () => {
  $('play').disabled = $('play-seed').disabled = true;
  startSeed().catch((err) => { setStatus(err.message, true); $('play').disabled = $('play-seed').disabled = false; });
});
$('forget').addEventListener('click', async () => {
  await kvDel(assetsKey);
  setStatus('');
  showReady();
});
$('forget-bases').addEventListener('click', async () => {
  await kvDel(BASES_KEY);
  setStatus('');
  showReady();
});
$('forget-seed').addEventListener('click', async () => {
  await kvDel(SEED_KEY);
  setStatus('');
  showReady();
});
$('rom-input-2').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) onRomChosen(file);
});
$('fullscreen').addEventListener('click', () => {
  $('game').requestFullscreen?.();
  $('canvas').focus();
});

await loadBuildInfo();
// Controls picture and key bindings; defaults come from keymap.ini.
let controls;
try {
  const keymapText = await (await fetch('keymap.ini' + ver)).text();
  controls = createControls({ keymapText, root: $('pad') });
} catch (e) {
  console.warn('Controls failed to load', e);
  controls = createControls({ keymapText: '', root: $('pad') });
}
await showReady();
ready = true;
checkRoomSeed();
