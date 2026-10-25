// Randomizer seeds: ROM identification, one game per room, and the emulator
// backend's lookups. No real ROM is needed: the tests build fake ones.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from '../index.js';
import { SyncClient } from '../../web/site/sync/client.js';
import { Room, VANILLA_GAME } from '../../web/site/sync/room.js';
import { snapshot } from '../../web/site/sync/fields.js';
import { identifyRom } from '../../web/site/rom-info.js';
import { findRoutines } from '../../web/site/sync/snes-backend.js';
import { parseKeymap } from '../../web/site/controls.js';

const SEED_A = { id: 'seed:VT TEST:0001020304', label: 'seed Bow, Boomerang, Hookshot, Bomb, Mushroom' };
const SEED_B = { id: 'seed:VT TEST:0506070809', label: 'seed Powder, Rod, Pendant, Bombos, Ether' };

const sends = (out, t) => out.filter((o) => o.msg.t === t);

test('the first player sets the room\'s game; others need the same one', () => {
  const room = new Room('ABCD');
  const a = room.connect(), b = room.connect(), c = room.connect();
  const welcome = sends(room.message(a, { t: 'hello', name: 'A', game: SEED_A }), 'welcome')[0].msg;
  assert.deepEqual(welcome.game, SEED_A);
  assert.equal(welcome.v, 4);
  assert.equal(sends(room.message(b, { t: 'hello', name: 'B', game: SEED_A }), 'welcome').length, 1);
  const out = room.message(c, { t: 'hello', name: 'C', game: SEED_B });
  assert.deepEqual(sends(out, 'wrong-game')[0].msg.game, SEED_A);
  assert.equal(sends(out, 'welcome').length, 0);
  assert.deepEqual(room.playerList().map((p) => p.name), ['A', 'B']);
  assert.deepEqual(room.disconnect(c), []);   // never joined
  assert.deepEqual(room.toJSON().game, SEED_A);
});

test('pages from before seeds count as the US game', () => {
  const room = new Room('ABCD');
  const a = room.connect(), b = room.connect();
  room.message(a, { t: 'hello', name: 'Old page' });
  assert.deepEqual(room.game, VANILLA_GAME);
  assert.equal(sends(room.message(b, { t: 'hello', name: 'B', game: SEED_A }), 'wrong-game').length, 1);
});

test('an empty room with no progress can switch games; one with progress keeps its game', () => {
  const room = new Room('ABCD');
  const a = room.connect();
  room.message(a, { t: 'hello', game: SEED_A });
  room.disconnect(a);
  const b = room.connect();
  assert.equal(sends(room.message(b, { t: 'hello', game: SEED_B }), 'welcome').length, 1);
  assert.deepEqual(room.game, SEED_B);

  const saved = new Room('ABCD', { state: { rooms: [] }, game: SEED_A });
  const c = saved.connect();
  assert.equal(sends(saved.message(c, { t: 'hello', game: SEED_B }), 'wrong-game').length, 1);
});

test('a sync from a page that doesn\'t know the randomizer fields is still accepted', () => {
  const room = new Room('ABCD');
  const a = room.connect();
  room.message(a, { t: 'hello', game: VANILLA_GAME });
  const mem = new Uint8Array(0x20000);
  const state = snapshot({ get: (x) => mem[x], set: (x, v) => { mem[x] = v; } });
  delete state.swapItems;
  delete state.bowFlags;
  const synced = sends(room.message(a, { t: 'sync', state }), 'synced')[0].msg;
  assert.deepEqual(synced.state.swapItems, [0]);
  // ...and ops for a field missing from a stored state apply too.
  delete room.state.bowFlags;
  room.message(a, { t: 'ops', ops: [{ k: 'bowFlags', bits: { 0: 0x80 } }] });
  assert.deepEqual(room.state.bowFlags, [0x80]);
});

test('a client with another seed is kept out of the room and says why', async () => {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/sync`;
  const backend = { ram: { get: () => 0, set: () => {} }, inGame: () => false };
  const statuses = [];
  const a = new SyncClient({ url, room: 'SEEDS', name: 'A', backend, game: SEED_A });
  a.start();
  await new Promise((r) => setTimeout(r, 200));
  const b = new SyncClient({
    url, room: 'SEEDS', name: 'B', backend, game: SEED_B,
    onStatus: (s) => statuses.push(s),
  });
  b.start();
  await new Promise((r) => setTimeout(r, 300));
  const last = statuses.at(-1);
  assert.equal(last.state, 'wrong-game');
  assert.equal(last.detail, SEED_A.label);
  assert.equal(b.closed, true);
  assert.deepEqual(a.players.map((p) => p.name), ['A']);
  a.stop();
  b.stop();
  server.close();
});

// A fake randomizer ROM: 2 MiB, LoROM reset vector, title and seed code.
function fakeRom(code, cosmetic = 0) {
  const rom = new Uint8Array(0x200000);
  rom[0] = 0x78;                       // SEI
  rom[0x7ffc] = 0x00; rom[0x7ffd] = 0x80;
  rom.set(new TextEncoder().encode('VT TEST'), 0x7fc0);
  rom.set(code, 0x180215);
  rom[0x100000] = cosmetic;            // e.g. Link's sprite or heart color
  return rom;
}

test('ROM identification: same seed matches despite cosmetics, other seeds don\'t', async () => {
  const a1 = await identifyRom(fakeRom([0, 1, 2, 3, 4]));
  const a2 = await identifyRom(fakeRom([0, 1, 2, 3, 4], 7));
  const b = await identifyRom(fakeRom([5, 6, 7, 8, 9]));
  assert.equal(a1.vanilla, false);
  assert.equal(a1.gameId, a2.gameId);
  assert.notEqual(a1.sha1, a2.sha1);
  assert.notEqual(a1.gameId, b.gameId);
  assert.deepEqual(a1.code, ['Bow', 'Boomerang', 'Hookshot', 'Bomb', 'Mushroom']);
  await assert.rejects(identifyRom(new Uint8Array(0x100000)), /doesn't look like/);
  await assert.rejects(identifyRom(new Uint8Array(0x1000)), /wrong size/);
});

test('the emulator backend finds the game\'s redraw routines in US and Japanese layouts', () => {
  const rom = new Uint8Array(0x100000);
  const put = (adr, hex) => rom.set(hex.match(/../g).map((h) => parseInt(h, 16)), ((adr >> 16) & 0x7f) * 0x8000 + (adr & 0x7fff));
  // Japanese 1.0 layout: the sword at $00:D308 (where the US ROM has the shield).
  put(0x00D308, '8b4baba05f20aaaaa05e20bbbbc221af59f37e');
  put(0x00D348, '8b4baba05f20aaaaa05e20bbbbc221af5af37e');
  put(0x1BED03, 'c221af59f37e');
  const found = findRoutines(rom);
  assert.equal(found.swordGfx, 0x00D308);
  assert.equal(found.shieldGfx, 0x00D348);
  assert.equal(found.swordPal, 0x1BED03);
  assert.equal(found.hud, undefined);   // not in this ROM: that redraw is skipped
});

test('default controls come from web/keymap.ini', () => {
  const { main, extra } = parseKeymap(readFileSync(new URL('../../web/keymap.ini', import.meta.url), 'utf8'));
  assert.deepEqual(main, {
    up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', select: 'KeyF', start: 'KeyG',
    a: 'KeyJ', b: 'KeyM', x: 'KeyI', y: 'KeyL', l: 'KeyQ', r: 'KeyE',
  });
  // Backup keys from the second Controls line
  assert.equal(extra.get('ArrowUp'), 'up');
  assert.equal(extra.get('Enter'), 'start');
  assert.equal(extra.get('ShiftRight'), 'select');
});
