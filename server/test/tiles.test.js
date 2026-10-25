// Shared room objects (pots, switches, doors...): tilemap changes travel to
// the others in the room and get queued for redraw. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../index.js';
import { SyncClient } from '../../web/site/sync/client.js';
import { RoomTiles } from '../../web/site/sync/tiles.js';

// A fake game standing in dungeon room 0x12, with a pot drawn at tilemap word 0x105.
function fakeGame() {
  const mem = new Uint8Array(0x20000);
  mem[0x10] = 0x07; mem[0x1B] = 1; mem[0xA0] = 0x12;
  mem[0x2000 + 0x105 * 2] = 0x34; mem[0x2000 + 0x105 * 2 + 1] = 0x12;
  return {
    mem,
    ram: { get: (a) => mem[a], set: (a, v) => { mem[a] = v; } },
    inGame: () => true,
    liftPot() { mem[0x2000 + 0x105 * 2] = 0x00; mem[0x2000 + 0x105 * 2 + 1] = 0x08; mem[0x12105] = 0x00; mem[0xF580 + 0x24] |= 1; },
  };
}

test('applying a change queues the redraw like the game does', () => {
  const g = fakeGame();
  const t = new RoomTiles(g, () => {});
  t.tick(1, null);                          // baseline
  t.apply([0x2000 + 0x105 * 2, 0x00, 0x2000 + 0x105 * 2 + 1, 0x08, 0x12105, 0x00, 0x30, 0x55]);
  assert.equal(g.mem[0x2000 + 0x105 * 2 + 1], 0x08);
  assert.equal(g.mem[0x30], 0);              // outside the shared areas: ignored
  // One upload entry: VRAM address of word 0x105, 2 bytes, the new tile.
  const va = ((0x20a & 0x40) << 4) | ((0x20a & 0x303f) >> 1) | ((0x20a & 0xf80) >> 2);
  assert.deepEqual([...g.mem.slice(0x1002, 0x1009)], [va >> 8, va & 0xff, 0, 1, 0x00, 0x08, 0xff]);
  assert.equal(g.mem[0x1000], 6);
  assert.equal(g.mem[0x14], 1);
});

const until = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + cond);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('a pot lifted in one game disappears in the others, also for latecomers', async () => {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/sync`;
  const ga = fakeGame(), gb = fakeGame(), gc = fakeGame();
  const a = new SyncClient({ url, room: 'TXLS', name: 'A', backend: ga });
  const b = new SyncClient({ url, room: 'TXLS', name: 'B', backend: gb });
  a.start(); b.start();
  await until(() => a.mobs.owner?.n === 2 && b.mobs.owner?.n === 2 && a.tiles.last && b.tiles.last);
  gb.liftPot();                              // B isn't the host: still shared
  await until(() => ga.mem[0x2000 + 0x105 * 2 + 1] === 0x08 && ga.mem[0xF5A4] === 1);
  assert.equal(ga.mem[0x14], 1);
  // C arrives later and gets the room as it is now from the host.
  const c = new SyncClient({ url, room: 'TXLS', name: 'C', backend: gc });
  c.start();
  await until(() => gc.mem[0x2000 + 0x105 * 2 + 1] === 0x08 && gc.mem[0xF5A4] === 1);
  // Nobody sends it back: B's own copy stays the only change.
  assert.equal(b.tiles.changes.size, a.tiles.changes.size);
  a.stop(); b.stop(); c.stop();
  server.close();
});

// Outdoors: a fake game in light world area 0x2C with a bush at map16 word 0x105.
function fakeOutdoors() {
  const g = fakeGame();
  g.mem[0x10] = 0x09; g.mem[0x1B] = 0; g.mem[0x8A] = 0x2C;
  g.mem[0xE3] = 0x08; g.mem[0xE9] = 0x0A;         // camera at the area's top left (2048, 2560)
  g.mem[0x2000 + 0x105 * 2] = 0x36; g.mem[0x2000 + 0x105 * 2 + 1] = 0x00;   // bush
  g.map16 = (v) => [v * 4, v * 4 + 1, v * 4 + 2, v * 4 + 3];
  g.cutBush = () => { g.mem[0x2000 + 0x105 * 2] = 0xC7; g.mem[0x2000 + 0x105 * 2 + 1] = 0x0D; };   // 0xDC7
  return g;
}

test('outdoors: a cut bush is redrawn from map16 and remembered', () => {
  const g = fakeOutdoors();
  const t = new RoomTiles(g, () => {});
  t.tick(1, null);
  assert.equal(t.b, 'o2c');
  t.apply([0x2000 + 0x105 * 2, 0xC7, 0x2000 + 0x105 * 2 + 1, 0x0D, 0x12105, 0x55]);
  assert.equal(g.mem[0x12105], 0);           // indoor-only region: ignored outdoors
  const va = 0x0a + ((0x20a & 0x780) >> 1);   // byte offset 0x20a: left half, row 4
  const t0 = 0xDC7 * 4;
  const le = (v) => [v & 0xff, (v >> 8) & 0xff];
  assert.deepEqual([...g.mem.slice(0x1002, 0x1002 + 17)], [
    va >> 8, va & 0xff, 0, 3, ...le(t0), ...le(t0 + 1),
    (va + 0x20) >> 8, (va + 0x20) & 0xff, 0, 3, ...le(t0 + 2), ...le(t0 + 3), 0xff]);
  // In the game's list of changed tiles, to survive a trip indoors.
  assert.equal(g.mem[0x4AC], 2);
  // A tile out of view changes in the map but isn't drawn: it would land on
  // the screen's tilemap where something else shows.
  g.mem[0x14] = 0; g.mem[0x1000] = 0;
  t.apply([0x2000 + 0x7C0 * 2, 0xC7, 0x2000 + 0x7C0 * 2 + 1, 0x0D]);   // row 31, column 0
  assert.equal(g.mem[0x2000 + 0x7C0 * 2 + 1], 0x0D);
  assert.equal(g.mem[0x14], 0);
  assert.deepEqual([...g.mem.slice(0xF800, 0xF802)], [0x0a, 0x02]);
  assert.deepEqual([...g.mem.slice(0xFA00, 0xFA02)], [0xC7, 0x0D]);
});

test('outdoors: a bush cut by one player is gone for the other', async () => {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/sync`;
  const ga = fakeOutdoors(), gb = fakeOutdoors();
  const a = new SyncClient({ url, room: 'BXSH', name: 'A', backend: ga });
  const b = new SyncClient({ url, room: 'BXSH', name: 'B', backend: gb });
  a.start(); b.start();
  await until(() => a.mobs.owner?.n === 2 && b.mobs.owner?.n === 2 && a.tiles.last && b.tiles.last);
  gb.cutBush();
  await until(() => ga.mem[0x2000 + 0x105 * 2 + 1] === 0x0D && ga.mem[0x14] === 1);
  a.stop(); b.stop();
  server.close();
});
