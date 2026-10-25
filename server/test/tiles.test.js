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
