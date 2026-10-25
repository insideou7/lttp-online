// LTTP Online page logic: get assets from the player's ROM (once), then run the game.
import { SyncClient, resolveSyncUrl } from './sync/client.js';
import { zelda3Backend } from './sync/zelda3-backend.js';
import { isRoomCode, newRoomCode } from './sync/room.js';

const US_ROM_SHA1 = '6d4f10a8b10e10dbe624cb23cf03b88bb8252973';
const GAME_DIR = '/zelda3';

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
let buildInfo = {};
async function loadBuildInfo() {
  try {
    buildInfo = await (await fetch('build.json')).json();
    assetsKey = 'assets-' + buildInfo.zelda3;
  } catch { /* keep default key */ }
}

// --- ROM -> assets ---------------------------------------------------------
async function sha1Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function romFromFile(file) {
  let rom = new Uint8Array(await file.arrayBuffer());
  // Strip a 512-byte copier header (.smc files often have one).
  if ((rom.length & 0xfffff) === 0x200) rom = rom.slice(0x200);
  const hash = await sha1Hex(rom);
  if (hash !== US_ROM_SHA1) {
    throw new Error('This ROM isn\'t the US version of A Link to the Past (SHA-1 ' + hash +
      '). The asset tool needs the unmodified US ROM.');
  }
  return rom;
}

function extractAssets(rom) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('extract-worker.js', import.meta.url), { type: 'module' });
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

async function onRomChosen(file) {
  const progress = $('progress');
  try {
    setStatus('Checking ROM…');
    const rom = await romFromFile(file);
    progress.hidden = false;
    const t0 = performance.now();
    const assets = await extractAssets(rom);
    await kvSet(assetsKey, assets);
    setStatus(`Assets ready (${((performance.now() - t0) / 1000).toFixed(0)} s).`);
    showReady();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    progress.hidden = true;
    $('rom-input').value = '';
  }
}

function showReady() {
  $('need-rom').hidden = true;
  $('ready').hidden = false;
  $('play').focus();
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
    import('./zelda3.js'),
    fetch('zelda3.ini').then((r) => r.text()),
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

  $('setup').hidden = true;
  $('multiplayer').hidden = true;
  $('game').hidden = false;
  game.callMain([]);
  canvas.focus();
  window.lttp = game;  // handy for debugging from the console
  startSync(game);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistSaves();
  });
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
}

function showNotice(html) {
  const el = document.createElement('div');
  el.className = 'notice';
  el.innerHTML = html;
  $('notices').append(el);
  setTimeout(() => { el.style.opacity = '0'; }, 3500);
  setTimeout(() => el.remove(), 4000);
}
const escapeHtml = (t) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function startSync(game) {
  if (!roomCode) return;
  const statusEl = $('mp-status');
  const label = { connecting: 'connecting…', reconnecting: 'reconnecting…', connected: '',
    unreachable: "can't reach the sync server, playing solo for now", error: 'sync error' };
  const sync = new SyncClient({
    url: resolveSyncUrl(buildInfo),
    room: roomCode,
    name: $('mp-name').value.trim() || 'Link',
    backend: zelda3Backend(game),
    onStatus: ({ state, detail, players, you }) => {
      let text = `Room ${roomCode}: ` + (label[state] ?? state);
      if (state === 'connected') {
        text += players.map((p) => (p.id === you ? p.name + ' (you)' : p.name)).join(', ');
      }
      statusEl.textContent = text + (detail ? ` (${detail})` : '');
      statusEl.classList.toggle('error', state === 'unreachable' || state === 'error');
    },
    onNotice: ({ name, what }) => showNotice(`<b>${escapeHtml(name)}</b> got ${escapeHtml(what)}`),
  });
  sync.start();
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
  $('play').disabled = true;
  startGame().catch((err) => { setStatus(err.message, true); $('play').disabled = false; });
});
$('forget').addEventListener('click', async () => {
  await kvDel(assetsKey);
  setStatus('');
  showNeedRom();
});
$('fullscreen').addEventListener('click', () => {
  $('game').requestFullscreen?.();
  $('canvas').focus();
});

await loadBuildInfo();
if (await kvGet(assetsKey)) showReady();
