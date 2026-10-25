// Sharing a room's randomizer seed without sharing the game. A player who has
// the seed makes a BPS patch from the original ROM it was built from (the
// Japanese 1.0 ROM for ALttPR) to the seed. Only that patch, the randomizer's
// own changes, goes through the room. A friend who joins rebuilds the seed
// from their own copy of the original ROM and checks it's the room's game.
//
// Patch metadata (JSON): { base: { sha1, label, size }, seed: { sha1, gameId } }.
import { createBps, applyBps, bpsInfo, deflate, inflate } from '../bps.js';
import { identifyRom, BASE_ROMS } from '../rom-info.js';

const PART_CHARS = 48 * 1024;   // base64 characters per message (room.js allows 64 KiB)

// The original ROM a seed was most likely built from: the one sharing the most
// bytes with it at the same offsets (randomizers keep most of the game in place).
export function chooseBase(seedRom, bases) {
  let best = null, bestSame = -1;
  for (const base of bases) {
    let same = 0;
    const n = Math.min(base.rom.length, seedRom.length);
    for (let i = 0; i < n; i += 61) if (base.rom[i] === seedRom[i]) same++;
    if (same > bestSame) { best = base; bestSame = same; }
  }
  return best;
}

// bases: [{ sha1, label, rom }]. Returns the deflated patch, or throws with
// err.needsBase set when this browser has no original ROM to diff against.
export async function makeSeedPatch(seedRom, seedInfo, bases) {
  const base = chooseBase(seedRom, bases);
  if (!base) {
    throw Object.assign(new Error('the player sharing the seed has no original ROM loaded to make a patch from'), { needsBase: true });
  }
  const meta = JSON.stringify({
    base: { sha1: base.sha1, label: base.label, size: base.rom.length },
    seed: { sha1: seedInfo.sha1, gameId: seedInfo.gameId },
  });
  return deflate(createBps(base.rom, seedRom, meta));
}

// What a patch needs: { base: { sha1, label, size }, seed: { sha1, gameId } }.
export async function patchNeeds(patchZ) {
  const info = bpsInfo(await inflate(patchZ));
  let meta;
  try { meta = JSON.parse(info.metadata); } catch { meta = null; }
  if (!meta?.base?.sha1 || !meta?.seed?.gameId) throw new Error('The shared seed is damaged.');
  meta.base.label = BASE_ROMS[meta.base.sha1] ?? String(meta.base.label ?? 'original');
  return meta;
}

// Rebuilds the seed from the patch and one of `bases`. Returns { rom, info }.
// Throws with err.needsBase = { sha1, label } if the right original ROM isn't
// among them, or a plain error if the result isn't the room's game.
export async function rebuildSeed(patchZ, bases, wantGameId) {
  const patch = await inflate(patchZ);
  const meta = await patchNeeds(patchZ);
  const base = bases.find((b) => b.sha1 === meta.base.sha1);
  if (!base) {
    throw Object.assign(new Error(`This seed is built from the ${meta.base.label} ROM of A Link to the Past. Load your copy of it once, and the seed is set up for you.`),
      { needsBase: meta.base });
  }
  const rom = applyBps(base.rom, patch);
  const info = await identifyRom(rom);
  if (info.sha1 !== meta.seed.sha1 || (wantGameId && info.gameId !== wantGameId)) {
    throw new Error("The seed sent by the room doesn't match the room's game.");
  }
  return { rom, info };
}

// --- Transport ---------------------------------------------------------------
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// The messages that send a patch to the page `to`, for SyncClient.
export function patchMessages(patchZ, to) {
  const b64 = toB64(patchZ);
  const n = Math.max(1, Math.ceil(b64.length / PART_CHARS));
  return Array.from({ length: n }, (_, i) => ({ t: 'seed-part', to, i, n, d: b64.slice(i * PART_CHARS, (i + 1) * PART_CHARS) }));
}

// Asks room `room` what it plays, before joining it. have: game ids this
// browser already has. Resolves to one of
//   { game: null }                   nobody has started a game there yet
//   { game, have: true }             the US game, or a seed this browser has
//   { game, patch }                  a seed, sent by a player in the room
//   { game, error }                  a seed nobody could send right now
// Rejects if the sync server can't be reached.
export function askRoomSeed({ url, room, have = [], WebSocketImpl = globalThis.WebSocket, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    u.searchParams.set('room', room);
    const ws = new WebSocketImpl(u.toString());
    let game, parts = null, got = 0, settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      fn(v);
    };
    const timer = setTimeout(() => (game === undefined
      ? done(reject, new Error("The sync server didn't answer."))
      : done(resolve, { game, error: 'The player sharing the seed stopped answering.' })), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'seed-get', have }));
    ws.onerror = () => done(reject, new Error("Couldn't reach the sync server."));
    ws.onclose = () => done(reject, new Error("Couldn't reach the sync server."));
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.t) {
        case 'seed-info':
          game = msg.game ?? null;
          if (!game) done(resolve, { game: null });
          else if (!msg.sending) {
            done(resolve, have.includes(game.id) || game.id === 'lttp-us'
              ? { game, have: true }
              : { game, error: 'Nobody in the room who has the seed is playing right now.' });
          }
          break;
        case 'seed-part':
          if (!parts || parts.length !== msg.n) { parts = new Array(msg.n); got = 0; }
          if (parts[msg.i] === undefined) got++;
          parts[msg.i] = msg.d;
          if (got === parts.length) done(resolve, { game, patch: fromB64(parts.join('')) });
          break;
        case 'seed-fail':
          done(resolve, { game, error: `The seed couldn't be sent: ${msg.why || 'unknown reason'}.` });
          break;
        case 'error':
          console.warn('[seed] server:', msg.message);
          break;
      }
    };
  });
}
