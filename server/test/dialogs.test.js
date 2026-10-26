// Shared text boxes: copying a box out of fake video memory, and relaying it
// between two clients through the real server. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../index.js';
import { SyncClient } from '../../web/site/sync/client.js';
import { Room } from '../../web/site/sync/room.js';
import { readTextBox, captureTextBox, decodeTextBox, DialogSender, RemoteDialogs } from '../../web/site/sync/dialogs.js';
import { areaKey } from '../../web/site/sync/mobs.js';

// Fake game in a dungeon room. openBox(w) puts up a w-tile-wide text box at
// tile (4, 18), the US game's lower position ($6244): border corners are tile
// 0xF3 (the right one flipped), the rest blank but for one letter tile 0x180
// in palette 6 whose top-left pixel is color 3.
function fakeGame() {
  const mem = new Uint8Array(0x20000);
  const vram = new Uint16Array(0x8000);
  const cgram = new Uint16Array(256);
  const w16 = (a, v) => { mem[a] = v & 0xff; mem[a + 1] = v >> 8; };
  mem[0x10] = 0x07; mem[0x1B] = 1; w16(0xA0, 0x104);
  for (let i = 0; i < 32; i++) cgram[i] = 0x100 + i;
  const g = {
    mem, vram, cgram,
    ram: { get: (a) => mem[a], set: (a, v) => { mem[a] = v; } },
    video: { vram: (w) => vram[w], cgram: (i) => cgram[i], objBase: () => 0x4000, objSizes: () => [8, 16] },
    inGame: () => true,
    openBox(w = 24) {
      w16(0x1CD2, 0x6244);
      mem[0x10] = 0x0E; mem[0x11] = 0x02; mem[0x1CD4] = 3;
      vram[0x6244] = 0x28f3;
      vram[0x6244 + w - 1] = 0x68f3;
      vram[0x6244 + 0x21] = 0x3980;
      vram[0x7000 + 0x180 * 8] = 0x8080;   // planes 0 and 1: color 3
    },
    letter(on) { vram[0x7000 + 0x180 * 8 + 1] = on ? 0x8080 : 0; },
    closeBox() { mem[0x10] = 0x07; mem[0x11] = 0; mem[0x1CD4] = 4; },
  };
  return g;
}

test('reads and copies the text box', () => {
  const g = fakeGame();
  assert.equal(readTextBox(g.ram), null);
  g.openBox();
  assert.deepEqual(readTextBox(g.ram), { at: 0x6244, col: 4, row: 18 });
  const box = decodeTextBox(captureTextBox(g.ram, g.video));
  assert.deepEqual([box.col, box.row, box.w, box.h], [4, 18, 192, 64]);
  assert.deepEqual(box.c, [0x100 + 6 * 4 + 3]);
  assert.equal(box.px[8 * 192 + 8], 1);               // the letter's pixel
  assert.equal(box.px.filter(Boolean).length, 1);
  g.mem[0x1CD4] = 2;                                  // still drawing the border
  assert.equal(captureTextBox(g.ram, g.video), null);
});

test('the Japanese game\'s box is a tile narrower', () => {
  const g = fakeGame();
  g.openBox(23);
  assert.equal(decodeTextBox(captureTextBox(g.ram, g.video)).w, 23 * 8);
});

test('rejects broken box data', () => {
  const g = fakeGame();
  g.openBox();
  const bytes = captureTextBox(g.ram, g.video);
  assert.equal(decodeTextBox(bytes.subarray(0, 100)), null);
  const bad = bytes.slice();
  bad[bad.length - 1] = 9;                            // color 9 of 1
  assert.equal(decodeTextBox(bad), null);
});

test('sends the box while it is up, then a close', async () => {
  const g = fakeGame();
  const sent = [];
  const s = new DialogSender(g, (m) => sent.push(m));
  await s.tick(0);
  assert.equal(sent.length, 0);
  g.openBox();
  await s.tick(1000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].k, 'u104');                    // the room it opened in
  await s.tick(1050);
  assert.equal(sent.length, 1);                       // unchanged, not yet repeated
  g.letter(true);
  await s.tick(1100);
  assert.equal(sent.length, 1);                       // changed, but too soon
  await s.tick(1200);
  assert.equal(sent.length, 2);
  await s.tick(2300);
  assert.equal(sent.length, 3);                       // repeated for newcomers
  const r = new RemoteDialogs();
  await r.onDlg(7, sent[2].k, sent[2].d, () => 2300);
  const [shown] = r.visible('u104', 2400);
  assert.equal(shown.id, 7);
  assert.equal(shown.box.px[9 * 192 + 8], 1);         // the second row of the letter
  assert.equal(r.visible('u105', 2400).length, 0);    // another room
  assert.equal(r.visible('u104', 9000).length, 0);    // nobody repeated it
  g.closeBox();
  await s.tick(2400);
  assert.deepEqual(sent[3], { t: 'dlg', k: 'u104', d: null });
});

test('room relays boxes to the area the speaker was in', () => {
  const room = new Room('ABCD');
  const a = room.connect(), b = room.connect(), c = room.connect();
  room.message(a, { t: 'at', k: 'u104' });
  room.message(b, { t: 'at', k: 'u104' });
  room.message(c, { t: 'at', k: 'u105' });
  room.message(a, { t: 'at', k: null });              // paused for the text
  const out = room.message(a, { t: 'dlg', k: 'u104', d: 'AAAA' });
  assert.deepEqual(out, [{ to: b, msg: { t: 'dlg', from: a, k: 'u104', d: 'AAAA' } }]);
  assert.deepEqual(room.message(a, { t: 'dlg', k: 'u104', d: null })[0].msg.d, null);
  assert.deepEqual(room.message(a, { t: 'dlg', k: 'u105', d: 'AAAA' }), []);   // wasn't there
  assert.equal(room.message(a, { t: 'dlg', k: 'u104', d: '<b>' })[0].msg.t, 'error');
  assert.equal(room.message(a, { t: 'dlg', k: 'u104', d: 'A'.repeat(9000) })[0].msg.t, 'error');
});

const until = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + cond);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('a player in the same room sees the other\'s text box', async () => {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/sync`;
  const ga = fakeGame(), gb = fakeGame();
  const a = new SyncClient({ url, room: 'DLGS', name: 'A', backend: ga });
  const b = new SyncClient({ url, room: 'DLGS', name: 'B', backend: gb });
  a.start(); b.start();
  await until(() => a.mobs.owner && b.mobs.owner);
  await new Promise((r) => setTimeout(r, 300));       // both told the server where they are
  ga.openBox();
  await until(() => b.remoteDialogs.visible(areaKey(gb.ram)).length === 1);
  ga.closeBox();
  await until(() => b.remoteDialogs.visible(areaKey(gb.ram)).length === 0);
  a.stop(); b.stop();
  server.close();
});
