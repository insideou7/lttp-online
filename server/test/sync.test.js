// Multiplayer sync tests: merge rules, room logic, and two clients talking
// through the real server with fake game RAM. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../index.js';
import { SyncClient } from '../../web/site/sync/client.js';
import { FIELD_BY_KEY } from '../../web/site/sync/fields.js';
import { Room } from '../../web/site/sync/room.js';

// A fake game: 128 KiB of work RAM and a module byte saying we're in game.
function fakeGame() {
  const mem = new Uint8Array(0x20000);
  const refreshed = [];
  return {
    mem,
    refreshed,
    ram: { get: (a) => mem[a], set: (a, v) => { mem[a] = v; } },
    inGame: () => mem[0x10] === 0x09,
    refresh: (kinds) => { refreshed.push(...kinds); return true; },
    play() { mem[0x10] = 0x09; },
    quit() { mem[0x10] = 0x01; },
  };
}

function startServer() {
  const { server } = createServer();
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

function client(server, game, name, room = 'ABCDEF') {
  const notices = [];
  const c = new SyncClient({
    url: `ws://127.0.0.1:${server.address().port}/sync`, room, name, backend: game,
    onNotice: (n) => notices.push(`${n.name}: ${n.what}`),
  });
  c.notices = notices;
  c.start();
  return c;
}

const until = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + cond);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('bow tier keeps each player\'s own arrows bit', () => {
  const g = fakeGame();
  const bow = FIELD_BY_KEY.bow;
  g.mem[0xF377] = 0;           // no arrows
  bow.write(g.ram, 2);
  assert.equal(g.mem[0xF340], 3);
  g.mem[0xF377] = 10;
  bow.write(g.ram, 1);
  assert.equal(g.mem[0xF340], 2);
  assert.equal(bow.read(g.ram), 1);
});

test('heart quarters combine containers and pieces', () => {
  const g = fakeGame();
  const h = FIELD_BY_KEY.heartQuarters;
  g.mem[0xF36C] = 3 * 8; g.mem[0xF36B] = 3;
  assert.equal(h.read(g.ram), 15);
  h.write(g.ram, 16);
  assert.equal(g.mem[0xF36C], 32);
  assert.equal(g.mem[0xF36B], 0);
});

test('room seeds from the first player and rejects bad ops', () => {
  const room = new Room('ABCD');
  const a = room.connect();
  room.message(a, { t: 'hello', name: 'A' });
  assert.equal(room.message(a, { t: 'ops', ops: [] })[0].msg.t, 'error');
  const g = fakeGame();
  g.mem[0xF342] = 1;
  const [{ msg }] = room.message(a, { t: 'sync', state: snapshotOf(g) });
  assert.equal(msg.seeded, true);
  assert.equal(room.state.hookshot, 1);
  const out = room.message(a, { t: 'ops', ops: [{ k: 'hookshot', v: 999 }, { k: 'nope', v: 1 }, { k: 'heartQuarters', d: -4 }] });
  assert.deepEqual(out, []);
});

function snapshotOf(g) {
  return Object.fromEntries(Object.values(FIELD_BY_KEY).map((f) => [f.key, f.read(g.ram)]));
}

test('two players share unlocks but keep their own consumables', async (t) => {
  const server = await startServer();
  const A = fakeGame(), B = fakeGame();
  // A has played a while: sword, 4 hearts, a pendant, 200 rupees.
  A.mem[0xF359] = 1; A.mem[0xF36C] = 4 * 8; A.mem[0xF374] = 0x04; A.mem[0xF360] = 200;
  A.mem[0xF000 + 2 * 0x12] = 0x30;  // a room's chest flags
  // B starts a fresh file with 3 hearts and 50 rupees, and a bottle with a potion.
  B.mem[0xF36C] = 3 * 8; B.mem[0xF360] = 50; B.mem[0xF35C] = 3;
  A.play();
  const a = client(server, A, 'Ann');
  await until(() => a.known);
  B.play();
  const b = client(server, B, 'Bo');
  t.after(() => { a.stop(); b.stop(); server.close(); });
  await until(() => b.known);

  // B took on the room's progress...
  assert.equal(B.mem[0xF359], 1);
  assert.equal(B.mem[0xF36C], 32);
  assert.equal(B.mem[0xF374], 0x04);
  assert.equal(B.mem[0xF000 + 0x24], 0x30);
  // ...kept its own rupees,
  assert.equal(B.mem[0xF360], 50);
  // and its bottle reached A as an empty bottle (A keeps its own rupees too).
  await until(() => A.mem[0xF35C] === 2);
  assert.equal(A.mem[0xF360], 200);
  assert.equal(B.mem[0xF35C], 3);

  // A finds the hookshot: B gets it and a notice.
  A.mem[0xF342] = 1;
  await until(() => B.mem[0xF342] === 1);
  await until(() => b.notices.includes('Ann: Hookshot'));
  assert.ok(B.refreshed.includes('hud'));

  // Both pick up a heart piece at the same time: each ends with both pieces.
  A.mem[0xF36B] = 1; B.mem[0xF36B] = 1;
  await until(() => A.mem[0xF36B] === 2 && B.mem[0xF36B] === 2);

  // A's 4th piece: the game zeroes the pieces, then adds the container a bit
  // later. The dip must not be sent or undone; B ends with the container.
  A.mem[0xF36B] = 3; await until(() => B.mem[0xF36B] === 3);
  A.mem[0xF36B] = 0;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(B.mem[0xF36B], 3);
  A.mem[0xF36C] += 8;
  await until(() => B.mem[0xF36C] === 40 && B.mem[0xF36B] === 0);
  assert.equal(A.mem[0xF36C], 40);

  // The game overwrites a room's flags from an old copy: they come back.
  B.mem[0xF000 + 0x24] = 0x10;
  await until(() => B.mem[0xF000 + 0x24] === 0x30);

  // The smiths take A's sword: everyone's goes (last writer wins), then a
  // tempered one comes back.
  A.mem[0xF359] = 255;
  await until(() => B.mem[0xF359] === 255);
  A.mem[0xF359] = 3;
  await until(() => B.mem[0xF359] === 3);

  // B goes back to the file select and loads another file: unlocks made
  // meanwhile reach B when it's back in game.
  B.quit();
  await new Promise((r) => setTimeout(r, 200));
  A.mem[0xF34B] = 1;  // hammer
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(B.mem[0xF34B], 0);
  B.play();
  await until(() => B.mem[0xF34B] === 1);
});

test('gains made while disconnected are kept on reconnect', async (t) => {
  const server = await startServer();
  const A = fakeGame(), B = fakeGame();
  A.mem[0xF36C] = 24; B.mem[0xF36C] = 24;
  A.play(); B.play();
  const a = client(server, A, 'Ann', 'QWERTY');
  await until(() => a.known);
  const b = client(server, B, 'Bo', 'QWERTY');
  t.after(() => { a.stop(); b.stop(); server.close(); });
  await until(() => b.known);

  b.ws.close();
  await until(() => !b.known);
  B.mem[0xF36B] = 1;   // heart piece while offline
  A.mem[0xF36B] = 1;   // and one for A
  await until(() => b.known, 5000);  // client reconnects by itself
  await until(() => A.mem[0xF36B] === 2 && B.mem[0xF36B] === 2);
});
