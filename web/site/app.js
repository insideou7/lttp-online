// LTTP Online page logic: get assets from the player's ROM (once), then run the game.
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
let assetsKey = 'assets';
async function loadBuildInfo() {
  try {
    const info = await (await fetch('build.json')).json();
    assetsKey = 'assets-' + info.zelda3;
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
  $('game').hidden = false;
  game.callMain([]);
  canvas.focus();
  window.lttp = game;  // handy for debugging from the console
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistSaves();
  });
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
