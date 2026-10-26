// Randomizer-only progress (z3randomizer's save layout): triforce pieces,
// keysanity key totals, universal keys, NPC items, prize counts.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../index.js';
import { SyncClient } from '../../web/site/sync/client.js';
import { FIELD_BY_KEY, snapshot } from '../../web/site/sync/fields.js';

function fakeGame({ genericKeys = false } = {}) {
  const mem = new Uint8Array(0x20000);
  return {
    mem,
    ram: { get: (a) => mem[a], set: (a, v) => { mem[a] = v; }, genericKeys },
    inGame: () => mem[0x10] === 0x09,
    refresh: () => true,
    play() { mem[0x10] = 0x09; mem[0x40C] = 0xFF; mem[0xF36F] = genericKeys ? 0 : 0xFF; },
  };
}

async function pair(t, room, opts) {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/sync`;
  const A = fakeGame(opts), B = fakeGame(opts);
  A.play(); B.play();
  const mk = (game, name) => {
    const notices = [];
    const c = new SyncClient({ url, room, name, backend: game, onNotice: (n) => notices.push(`${n.name}: ${n.what}`) });
    c.notices = notices;
    c.start();
    return c;
  };
  // Room codes leave out I, O, 0 and 1.
  const a = mk(A, 'Ann');
  let b;
  t.after(() => { a.stop(); b?.stop(); server.close(); });
  await until(() => a.known);
  b = mk(B, 'Bo');
  await until(() => b.known);
  return { A, B, a, b };
}

const until = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + cond);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const u16 = (mem, a) => mem[a] | (mem[a + 1] << 8);

test('triforce pieces add up across players, past 255', async (t) => {
  const { A, B, b } = await pair(t, 'TRYFRCE');
  A.mem[0xF418] = 0xFF;   // 255 pieces
  await until(() => u16(B.mem, 0xF418) === 255);
  assert.ok(b.notices.includes('Ann: got a Triforce Piece'));
  // Both pick one up at the same moment: the team has 257.
  A.mem[0xF418] = 0x00; A.mem[0xF419] = 1;
  B.mem[0xF418] = 0x00; B.mem[0xF419] = 1;
  await until(() => u16(A.mem, 0xF418) === 257 && u16(B.mem, 0xF418) === 257);
});

test('keysanity: key totals, checked locations and prizes are shared', async (t) => {
  const { A, B } = await pair(t, 'KEYSANTY');
  // A opens a chest in the Eastern Palace (slot 2) holding a Desert key (slot 3)
  // while outside both dungeons: the randomizer adds it to the saved count.
  A.mem[0xF37C + 3] = 1;
  A.mem[0xF4E0 + 3] = 1;   // keys found in Desert Palace chests
  A.mem[0xF4C0 + 2] = 1;   // locations checked in Eastern Palace
  await until(() => B.mem[0xF37C + 3] === 1 && B.mem[0xF4E0 + 3] === 1 && B.mem[0xF4C0 + 2] === 1);
  // B checks two more Eastern Palace locations.
  B.mem[0xF4C0 + 2] = 3;
  await until(() => A.mem[0xF4C0 + 2] === 3);

  // Prizes: the dungeon is done, and the crystal count opens Ganon's Tower.
  A.mem[0xF472] |= 0x20; A.mem[0xF37A] |= 0x02; A.mem[0xF476] = 1;
  B.mem[0xF37A] |= 0x40; B.mem[0xF476] = 1;
  await until(() => A.mem[0xF476] === 2 && B.mem[0xF476] === 2 && B.mem[0xF472] === 0x20);
  assert.equal(A.mem[0xF37A], 0x42);
});

test('an NPC gives its item once for the whole team', async (t) => {
  const { A, B } = await pair(t, 'NPCSTUFF');
  A.mem[0xF410] = 0x80;   // the library item
  B.mem[0xF411] = 0x04;   // the smith
  await until(() => A.mem[0xF411] === 0x04 && B.mem[0xF410] === 0x80);
  A.mem[0xF416] = 0x20;   // HUD toggle: A's own
  B.mem[0xF416] = 0x01;   // the grove item
  await until(() => A.mem[0xF416] === 0x21);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(B.mem[0xF416], 0x01);
});

test('universal keys (retro mode) are one shared count, in and out of dungeons', async (t) => {
  const { A, B, a } = await pair(t, 'RETRKEYS', { genericKeys: true });
  // A buys a key in a shop: the game sets both the count and its copy.
  A.mem[0xF38B] = 1; A.mem[0xF36F] = 1;
  await until(() => B.mem[0xF38B] === 1 && B.mem[0xF36F] === 1);
  // B enters Eastern Palace and uses the key on a door: only the copy drops.
  B.mem[0x40C] = 4;
  await new Promise((r) => setTimeout(r, 250));
  B.mem[0xF36F] = 0;
  await until(() => A.mem[0xF36F] === 0 && A.mem[0xF38B] === 0);
  assert.ok(a.notices.includes('Bo: used a Small Key'));
  // The per-dungeon counts never moved.
  assert.equal(A.mem[0xF37C + 2], 0);
  assert.equal(B.mem[0xF37C + 2], 0);
});

test('without universal keys the generic count is not read', () => {
  const mem = new Uint8Array(0x20000);
  mem[0xF38B] = 5; mem[0xF36F] = 5; mem[0x40C] = 4;
  const state = snapshot({ get: (a) => mem[a], set: () => {} });
  assert.deepEqual(state.genericKeys, [0]);
  assert.equal(state.keys[2], 5);
  assert.equal(FIELD_BY_KEY.triforce.max, 999);
});

test('the emulator backend reads the universal keys flag from the seed', async () => {
  const { snesBackend } = await import('../../web/site/sync/snes-backend.js');
  const emu = (rom) => ({ rom, core: { HEAPU8: new Uint8Array(16) }, ram: () => 0, call: () => true });
  const rom = new Uint8Array(0x200000);
  assert.equal(snesBackend(emu(rom)).ram.genericKeys, false);
  rom[0x180172] = 1;
  assert.equal(snesBackend(emu(rom)).ram.genericKeys, true);
  // The plain Japanese ROM is too short to have the flag.
  assert.equal(snesBackend(emu(new Uint8Array(0x100000))).ram.genericKeys, false);
});
