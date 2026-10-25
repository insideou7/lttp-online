// Seeing each other: Link's picture from fake video memory, and positions
// relayed between two clients through the real server. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../index.js';
import { SyncClient } from '../../web/site/sync/client.js';
import { Room } from '../../web/site/sync/room.js';
import { captureLink, readView, fromBase64, PresenceSender, RemotePlayers } from '../../web/site/sync/presence.js';

// Fake game in the overworld with Link at (1000, 2000), camera at (900, 1900),
// so Link is at (100, 100) on screen. One 16x16 sprite at slot 100 (the game's
// usual Link slots) at screen (100, 92), tile 0, palette 7, flipped
// horizontally; its top-left pixel is color 1, top-right 15.
function fakeGame() {
  const mem = new Uint8Array(0x20000);
  const vram = new Uint16Array(0x8000);
  const cgram = new Uint16Array(256);
  const w16 = (a, v) => { mem[a] = v & 0xff; mem[a + 1] = v >> 8; };
  mem[0x10] = 0x09; mem[0x13] = 0x0f;
  w16(0x22, 1000); w16(0x20, 2000); w16(0xE2, 900); w16(0xE8, 1900);
  mem[0x8A] = 0x43;            // a dark world area
  w16(0x352, 0x190);
  for (let i = 0; i < 128; i++) mem[0x801 + i * 4] = 0xf0;   // all hidden
  const s = 0x800 + 100 * 4;
  mem[s] = 100; mem[s + 1] = 92; mem[s + 2] = 0x00; mem[s + 3] = 0x40 | (7 << 1);
  mem[0xA20 + 100] = 2;        // large
  // Tile 0 row 0: pixel 0 = color 1 (plane 0), pixel 7 = color 15 (all planes).
  vram[0x4000] = 0x80 | 0x01 | 0x0100;
  vram[0x4008] = 0x01 | 0x0100;
  for (let i = 0; i < 16; i++) cgram[0xF0 + i] = 0x100 + i;
  return {
    mem, vram, cgram,
    ram: { get: (a) => mem[a], set: (a, v) => { mem[a] = v; } },
    video: {
      vram: (w) => vram[w], cgram: (i) => cgram[i],
      objBase: (t) => (t ? 0x5000 : 0x4000), objSizes: () => [8, 16],
    },
    inGame: () => mem[0x10] === 0x09,
    move(dx) { w16(0x22, 1000 + dx); mem[s] = 100 + dx; },   // sprites move with him
  };
}

test('reads where Link is', () => {
  const g = fakeGame();
  assert.deepEqual(readView(g.ram), { loc: 'dw', x: 1000, y: 2000, camX: 900, camY: 1900, bright: 1 });
  g.mem[0x1B] = 1;
  assert.equal(readView(g.ram).loc, 'u');
  g.mem[0x10] = 0x0E;   // menu open
  assert.equal(readView(g.ram), null);
});

test('captures Link\'s sprites as one image', () => {
  const g = fakeGame();
  const img = captureLink(g.ram, g.video);
  assert.deepEqual([img.ox, img.oy, img.w, img.h], [0, -8, 16, 16]);
  const px = fromBase64(img.p);
  assert.equal(px.length, 256);
  // Flipped: tile pixel 0 lands at the right edge of the left 8x8 tile's mirror.
  const at = (x, y) => (px[y * 16 + x] ? img.c[px[y * 16 + x] - 1] : 0);
  assert.equal(at(15, 0), 0x101);
  assert.equal(at(8, 0), 0x10f);
  assert.equal(px.filter(Boolean).length, 2);
  // Hidden slots give nothing.
  g.mem[0x801 + 100 * 4] = 0xf0;
  assert.equal(captureLink(g.ram, g.video), null);
});

test('the ghost shows what Link carries', () => {
  const g = fakeGame();
  // A bush (sprite slot 3, carried) 16 pixels above Link, in OAM slot 20.
  g.mem[0xDD0 + 3] = 0x0A;
  g.mem[0xD10 + 3] = 1000 & 0xff; g.mem[0xD30 + 3] = 1000 >> 8;
  g.mem[0xD00 + 3] = (2000 - 4) & 0xff; g.mem[0xD20 + 3] = (2000 - 4) >> 8;
  g.mem[0xF70 + 3] = 12;
  const o = 0x800 + 20 * 4;
  g.mem[o] = 100; g.mem[o + 1] = 84; g.mem[o + 2] = 0x00; g.mem[o + 3] = 7 << 1;
  g.mem[0xA20 + 20] = 2;
  const img = captureLink(g.ram, g.video);
  assert.deepEqual([img.ox, img.oy, img.w, img.h], [0, -16, 16, 24]);
  g.mem[0xDD0 + 3] = 0x09;                    // put down: not his any more
  assert.equal(captureLink(g.ram, g.video).h, 16);
});

test('sends a pose image once, then only its id', () => {
  const g = fakeGame();
  const s = new PresenceSender(g);
  const a = s.next();
  assert.ok(a.img);
  assert.equal(s.next(), undefined);        // nothing moved
  g.move(1);
  const b = s.next();
  assert.equal(b.x, 1001);
  assert.equal(b.img, undefined);
  assert.equal(b.f, a.f);
  s.reset();
  g.move(2);
  assert.ok(s.next().img);                   // after a reset, again
  g.mem[0x10] = 0x0E;
  assert.equal(s.next(), null);              // gone from screen
  assert.equal(s.next(), undefined);
});

test('remote players show only on the same map and glide', () => {
  const g = fakeGame();
  const s = new PresenceSender(g);
  const r = new RemotePlayers();
  r.onPos(2, s.next(), 0);
  const view = readView(g.ram);
  assert.deepEqual(r.visible(view, 0).map((v) => [v.id, v.x, v.y]), [[2, 100, 92]]);
  g.move(10);
  r.onPos(2, s.next(), 100);
  assert.equal(r.visible(view, 100)[0].x, 100);
  assert.equal(r.visible(view, 150)[0].x, 105);
  assert.equal(r.visible(view, 300)[0].x, 110);
  assert.equal(r.visible({ ...view, loc: 'lw' }, 300).length, 0);
  r.retain([3]);
  assert.equal(r.visible(view, 300).length, 0);
});

test('room relays positions and rejects bad ones', () => {
  const room = new Room('ABCD');
  const a = room.connect(), b = room.connect();
  const g = fakeGame();
  const p = new PresenceSender(g).next();
  const out = room.message(a, { t: 'pos', p });
  assert.deepEqual(out, [{ to: 'others', from: a, msg: { t: 'pos', from: a, p } }]);
  assert.equal(room.message(b, { t: 'pos', p: null })[0].msg.p, null);
  for (const bad of [{ ...p, x: -1 }, { ...p, l: '<script>' }, { ...p, img: { ...p.img, w: 99 } },
    { ...p, img: { ...p.img, p: 'abc' } }, 'x']) {
    assert.equal(room.message(a, { t: 'pos', p: bad })[0].msg.t, 'error');
  }
  assert.equal(room.state, null);   // positions are never stored
});

const until = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + cond);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('two players see each other through the server', async () => {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/sync`;
  const ga = fakeGame(), gb = fakeGame();
  const a = new SyncClient({ url, room: 'PRES', name: 'A', backend: ga });
  a.start();
  await until(() => a.you);
  // B joins later: A sends its position and pose again for B.
  const b = new SyncClient({ url, room: 'PRES', name: 'B', backend: gb });
  b.start();
  await until(() => b.remote.players.get(a.you)?.pose);
  ga.move(20);
  await until(() => b.remote.players.get(a.you)?.x === 1020);
  assert.ok(a.remote.players.get(b.you)?.pose);
  // A leaves the screen, then the room.
  ga.mem[0x10] = 0x0E;
  await until(() => !b.remote.players.has(a.you));
  ga.mem[0x10] = 0x09;
  await until(() => b.remote.players.has(a.you));
  a.stop();
  await until(() => !b.remote.players.has(a.you));
  b.stop();
  server.close();
});
