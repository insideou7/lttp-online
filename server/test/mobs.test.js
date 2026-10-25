// Shared enemies: area ownership on the server, and two clients with fake
// game RAM fighting the same monster through the real server. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../index.js';
import { SyncClient } from '../../web/site/sync/client.js';
import { Room } from '../../web/site/sync/room.js';
import { areaKey, readSnapshot, writeSnapshot, SNAPSHOT_SIZE, MobSync } from '../../web/site/sync/mobs.js';
import { toBase64 } from '../../web/site/sync/presence.js';

const STATE = 0xDD0, TYPE = 0xE20, HEALTH = 0xE50, X = 0xD10;

// A fake game standing in dungeon room 0x12.
function fakeGame() {
  const mem = new Uint8Array(0x20000);
  mem[0x10] = 0x07; mem[0x1B] = 1; mem[0xA0] = 0x12;
  return {
    mem,
    ram: { get: (a) => mem[a], set: (a, v) => { mem[a] = v; } },
    inGame: () => [0x07, 0x09, 0x0E].includes(mem[0x10]),
    spawn(s, type, hp, x) { mem[STATE + s] = 9; mem[TYPE + s] = type; mem[HEALTH + s] = hp; mem[X + s] = x; },
  };
}

test('area keys: dungeon rooms and overworld blocks', () => {
  const g = fakeGame();
  assert.equal(areaKey(g.ram), 'u12');
  g.mem[0x1B] = 0; g.mem[0x10] = 0x09; g.mem[0x8A] = 0x1B;
  g.mem[0x23] = 0x02;    // x = 0x200: right half of a big area
  assert.equal(areaKey(g.ram), 'o1bq1');
  g.mem[0x10] = 0x0E;
  assert.equal(areaKey(g.ram), null);
});

test('snapshot round trip, keeping chosen slots', () => {
  const a = fakeGame(), b = fakeGame();
  a.spawn(3, 0x41, 4, 100);
  b.spawn(5, 0x42, 2, 50);
  const snap = readSnapshot(a.ram);
  assert.equal(snap.length, SNAPSHOT_SIZE);
  writeSnapshot(b.ram, snap, new Set([5]));
  assert.equal(b.mem[TYPE + 3], 0x41);
  assert.equal(b.mem[TYPE + 5], 0x42);   // kept
});

test('what the owner carries stays off our Link\'s head', () => {
  const owner = fakeGame(), us = fakeGame();
  owner.spawn(4, 0xEC, 0, 100);
  owner.mem[STATE + 4] = 0x0A;                // over the owner's Link's head
  const m = new MobSync(us, () => {});
  m.onMobs({ k: 'u12', d: toBase64(readSnapshot(owner.ram)) });
  assert.equal(us.mem[STATE + 4], 0);
  owner.mem[STATE + 4] = 0x0B;                // thrown: everyone sees it fly
  m.onMobs({ k: 'u12', d: toBase64(readSnapshot(owner.ram)) });
  assert.equal(us.mem[STATE + 4], 0x0B);
});

test('room: first in an area owns it, ownership passes on', () => {
  const room = new Room('ABCD');
  const a = room.connect(), b = room.connect(), c = room.connect();
  let out = room.message(a, { t: 'at', k: 'u12' });
  assert.deepEqual(out, [{ to: a, msg: { t: 'owner', k: 'u12', id: a, n: 1 } }]);
  out = room.message(b, { t: 'at', k: 'u12' });
  assert.deepEqual(out.map((o) => [o.to, o.msg.id, o.msg.n]), [[a, a, 2], [b, a, 2]]);
  room.message(c, { t: 'at', k: 'u12' });
  // Only the owner's enemies are relayed, to the others there.
  assert.deepEqual(room.message(b, { t: 'mobs', k: 'u12', d: 'AAAA' }), []);
  assert.deepEqual(room.message(a, { t: 'mobs', k: 'u12', d: 'AAAA' }).map((o) => o.to), [b, c]);
  // Hits go to the owner.
  assert.deepEqual(room.message(c, { t: 'hit', k: 'u12', s: 3, d: 'AAAA' }).map((o) => o.to), [a]);
  assert.deepEqual(room.message(a, { t: 'hit', k: 'u12', s: 3, d: 'AAAA' }), []);
  // The owner leaves: the next player there takes over.
  out = room.disconnect(a);
  assert.deepEqual(out.filter((o) => o.msg.t === 'owner').map((o) => [o.to, o.msg.id]), [[b, b], [c, b]]);
  room.message(b, { t: 'at', k: 'o1bq0' });
  assert.equal(room.owners.get('u12'), c);
  assert.equal(room.owners.get('o1bq0'), b);
  assert.equal(room.message(b, { t: 'at', k: '../x' })[0].msg.t, 'error');
});

const until = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + cond);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('two players fight the same enemies through the server', async () => {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/sync`;
  const ga = fakeGame(), gb = fakeGame();
  ga.spawn(0, 0x41, 6, 100);
  gb.spawn(0, 0x99, 1, 10);          // B's game loaded something else; A's wins
  const a = new SyncClient({ url, room: 'MXBS', name: 'A', backend: ga });
  a.start();
  await until(() => a.mobs.owner?.id === a.you);
  const b = new SyncClient({ url, room: 'MXBS', name: 'B', backend: gb });
  b.start();
  await until(() => gb.mem[TYPE] === 0x41 && b.mobs.written);
  // A's enemy moves: B sees it.
  ga.mem[X] = 120;
  await until(() => gb.mem[X] === 120);
  // B hits it: A takes B's copy, health and all.
  gb.mem[HEALTH] = 4;
  gb.mem[X] = 130;                   // knocked back
  await until(() => ga.mem[HEALTH] === 4 && ga.mem[X] === 130);
  // A rupee far from B leaves B's game (off screen): A keeps it.
  ga.spawn(2, 0xD9, 0, 200);
  await until(() => gb.mem[TYPE + 2] === 0xD9 && gb.mem[STATE + 2] === 9);
  await new Promise((r) => setTimeout(r, 150));
  gb.mem[STATE + 2] = 0;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ga.mem[STATE + 2], 9);
  // B picks up a rupee next to B: gone for A too.
  gb.mem[0x22] = 80;                 // B's Link x
  ga.spawn(1, 0xD9, 0, 80);
  await until(() => gb.mem[TYPE + 1] === 0xD9 && gb.mem[STATE + 1] === 9);
  await new Promise((r) => setTimeout(r, 150));
  gb.mem[STATE + 1] = 0;
  await until(() => ga.mem[STATE + 1] === 0);
  // A leaves: B owns the room now and keeps the enemy.
  ga.mem[0xA0] = 0x13;
  await until(() => b.mobs.owner?.id === b.you);
  assert.equal(gb.mem[TYPE], 0x41);
  a.stop(); b.stop();
  server.close();
});

test('enemies out of the owner\'s sight stay in our game', () => {
  const owner = fakeGame(), us = fakeGame();
  owner.spawn(0, 0x41, 4, 0x20);                 // in front of the owner
  us.spawn(0, 0x45, 4, 0x80);                    // a guard next to us...
  us.mem[0xD30] = 0x02;                          // ...at x 0x280
  us.spawn(5, 0x46, 4, 0x90); us.mem[0xD30 + 5] = 0x02;
  us.spawn(6, 0x47, 4, 0x60);                    // x 0x60: the owner sees that spot
  us.mem[0xE3] = 0x02;                           // our camera at x 0x200
  const m = new MobSync(us, () => {});
  const send = (camX) => m.onMobs({ k: 'u12', d: toBase64(Uint8Array.from([...readSnapshot(owner.ram), camX & 0xff, camX >> 8, 0, 0])) });
  send(0);
  assert.equal(us.mem[TYPE], 0x41);              // the owner's slot 0 wins...
  const types = [...us.mem.slice(TYPE, TYPE + 16)];
  assert.ok(types.includes(0x45));               // ...and our guard moved to a free slot
  assert.equal(us.mem[TYPE + 5], 0x46);          // kept where it was
  assert.equal(us.mem[STATE + 6], 0);            // the owner's copy says it's gone
  // The owner walks over (camera at x 0x200): its copy decides again.
  send(0x200);
  assert.equal(us.mem[STATE + 5], 0);
});
