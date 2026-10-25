// Sharing a room's seed as a patch: BPS round trips, the room relaying a patch
// from a player to a page that hasn't joined, and rebuilding the seed.
// No real ROM is needed: the tests build fake ones. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../index.js';
import { SyncClient } from '../../web/site/sync/client.js';
import { Room, VANILLA_GAME } from '../../web/site/sync/room.js';
import { createBps, applyBps, deflate } from '../../web/site/bps.js';
import { identifyRom } from '../../web/site/rom-info.js';
import { makeSeedPatch, rebuildSeed, askRoomSeed, chooseBase, patchMessages } from '../../web/site/sync/seed-share.js';

const sends = (out, t) => out.filter((o) => o.msg.t === t);

// A fake original game: 1 MiB of pseudo-random "code" with the LoROM reset
// vector, and a fake seed built from it the way randomizers do: same layout,
// some bytes changed, tables moved, and new code in an expanded second MiB.
function fakeBase(salt = 1) {
  const rom = new Uint8Array(0x100000);
  let x = 0x12345678 * salt;
  for (let i = 0; i < rom.length; i++) { x = (x * 1103515245 + 12345) >>> 0; rom[i] = x >>> 24; }
  rom[0] = 0x78;
  rom[0x7ffc] = 0x00; rom[0x7ffd] = 0x80;
  return rom;
}
function fakeSeed(base, code = [0, 1, 2, 3, 4]) {
  const rom = new Uint8Array(0x200000);
  rom.set(base);
  rom.set(new TextEncoder().encode('VT TEST'), 0x7fc0);
  for (let i = 0; i < 3000; i++) rom[(i * 7919) % 0x100000 | 0x8000] ^= 0x5a;   // item placements
  rom.set(base.subarray(0x20000, 0x24000), 0x150000);                       // a moved table
  for (let i = 0x100000; i < 0x140000; i++) rom[i] = (i * 31) & 0xff;       // new code
  rom.set(code, 0x180215);
  return rom;
}

test('BPS: a patch rebuilds the target and refuses another source', () => {
  const base = fakeBase();
  const seed = fakeSeed(base);
  const patch = createBps(base, seed, 'hello');
  assert.ok(patch.length < 0x50000, `patch is ${patch.length} bytes`);
  assert.deepEqual(applyBps(base, patch), seed);
  assert.throws(() => applyBps(fakeBase(2), patch), (e) => e.wrongSource);
  const bad = patch.slice(); bad[100] ^= 1;
  assert.throws(() => applyBps(base, bad), /damaged/);
  // Overlapping copies of what was already written, and an empty target.
  const rep = new Uint8Array(5000).map((_, i) => i % 3);
  assert.deepEqual(applyBps(new Uint8Array(10), createBps(new Uint8Array(10), rep)), rep);
  assert.deepEqual(applyBps(base, createBps(base, new Uint8Array(0))), new Uint8Array(0));
});

test('the patch holds the seed\'s changes, not the original game', () => {
  const base = fakeBase();
  const seed = fakeSeed(base);
  const patch = createBps(base, seed);
  // The moved 16 KiB table and the untouched code are copies, not bytes in the patch.
  const table = base.subarray(0x20000, 0x20040);
  const hay = Buffer.from(patch);
  assert.equal(hay.indexOf(Buffer.from(table)), -1);
  assert.equal(hay.indexOf(Buffer.from(base.subarray(0x40000, 0x40040))), -1);
});

test('a seed is rebuilt from the joiner\'s own original ROM and checked', async () => {
  const jp = fakeBase(), other = fakeBase(3);
  const seed = fakeSeed(jp);
  const info = await identifyRom(seed);
  const bases = [{ sha1: 'aa', label: 'Other', rom: other }, { sha1: 'bb', label: 'Japanese 1.0', rom: jp }];
  assert.equal(chooseBase(seed, bases).sha1, 'bb');
  const patchZ = await makeSeedPatch(seed, info, bases);
  const got = await rebuildSeed(patchZ, [{ sha1: 'bb', label: 'x', rom: jp }], info.gameId);
  assert.deepEqual(got.rom, seed);
  assert.equal(got.info.gameId, info.gameId);
  await assert.rejects(rebuildSeed(patchZ, [{ sha1: 'aa', label: 'Other', rom: other }], info.gameId),
    (e) => e.needsBase?.sha1 === 'bb');
  await assert.rejects(rebuildSeed(patchZ, bases, 'seed:VT TEST:0909090909'), /doesn't match/);
  await assert.rejects(makeSeedPatch(seed, info, []), (e) => e.needsBase);
});

test('room: a page asks what the room plays and a sharing player sends the patch', () => {
  const SEED = { id: 'seed:VT TEST:0001020304', label: 'seed X' };
  const room = new Room('ABCD');
  const asker0 = room.connect();
  assert.deepEqual(sends(room.message(asker0, { t: 'seed-get' }), 'seed-info')[0].msg, { t: 'seed-info', game: null, sending: false });

  const host = room.connect(), plain = room.connect();
  room.message(plain, { t: 'hello', name: 'P', game: SEED });
  room.message(host, { t: 'hello', name: 'H', game: SEED, share: true });
  // Pages that only ask don't show up as players.
  assert.deepEqual(room.playerList().map((p) => p.name), ['H', 'P']);

  const asker = room.connect();
  let out = room.message(asker, { t: 'seed-get', have: [] });
  assert.equal(sends(out, 'seed-info')[0].msg.sending, true);
  assert.deepEqual(sends(out, 'seed-want')[0], { to: host, msg: { t: 'seed-want', to: asker } });
  // Already has it: nothing is sent.
  out = room.message(asker, { t: 'seed-get', have: [SEED.id] });
  assert.equal(sends(out, 'seed-want').length, 0);

  out = room.message(host, { t: 'seed-part', to: asker, i: 0, n: 2, d: 'AAAA' });
  assert.deepEqual(out, [{ to: asker, msg: { t: 'seed-part', i: 0, n: 2, d: 'AAAA' } }]);
  // Not from a non-sharer, not to someone who never asked, nothing too big.
  assert.deepEqual(room.message(plain, { t: 'seed-part', to: asker, i: 0, n: 1, d: 'AAAA' }), []);
  assert.deepEqual(room.message(host, { t: 'seed-part', to: plain, i: 0, n: 1, d: 'AAAA' }), []);
  assert.equal(sends(room.message(host, { t: 'seed-part', to: asker, i: 0, n: 1, d: 'A'.repeat(70000) }), 'error').length, 1);
  assert.equal(sends(room.message(host, { t: 'seed-part', to: asker, i: 0, n: 99, d: 'AAAA' }), 'error').length, 1);
  assert.equal(room.message(host, { t: 'seed-fail', to: asker, why: 'no base\u0000' })[0].msg.why, 'no base');
  // A page leaving after asking doesn't send a players update.
  assert.deepEqual(sends(room.disconnect(asker), 'players'), []);

  // The US game needs nothing sent.
  const us = new Room('EFGH');
  const a = us.connect(), b = us.connect();
  us.message(a, { t: 'hello', game: VANILLA_GAME, share: true });
  assert.equal(sends(us.message(b, { t: 'seed-get' }), 'seed-want').length, 0);
});

test('end to end: a friend gets the seed from the host through the sync server', async () => {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/sync`;
  const jp = fakeBase();
  const seed = fakeSeed(jp);
  const info = await identifyRom(seed);
  const game = { id: info.gameId, label: info.label };
  let made = 0;
  const host = new SyncClient({
    url, room: 'SHARE', name: 'Host', game,
    backend: { ram: { get: () => 0, set: () => {} }, inGame: () => false },
    seedPatch: () => { made++; return makeSeedPatch(seed, info, [{ sha1: 'jp', label: 'Japanese 1.0', rom: jp }]); },
  });
  host.start();
  await new Promise((r) => setTimeout(r, 200));

  const res = await askRoomSeed({ url, room: 'SHARE', have: ['lttp-us'] });
  assert.deepEqual(res.game, game);
  const got = await rebuildSeed(res.patch, [{ sha1: 'jp', label: 'Japanese 1.0', rom: jp }], res.game.id);
  assert.deepEqual(got.rom, seed);
  assert.equal(made, 1);
  assert.deepEqual(host.players.map((p) => p.name), ['Host']);

  assert.deepEqual(await askRoomSeed({ url, room: 'SHARE', have: [game.id] }), { game, have: true });
  const empty = await askRoomSeed({ url, room: 'EMPTY' });
  assert.deepEqual(empty, { game: null });

  // Bigger patches go in several parts.
  const big = new Uint8Array(200000).map(() => Math.random() * 256);
  host.seedPatch = async () => big;
  assert.ok(patchMessages(big, 1).length > 1);
  assert.deepEqual((await askRoomSeed({ url, room: 'SHARE' })).patch, big);

  // A host with no original ROM says so.
  host.seedPatch = () => makeSeedPatch(seed, info, []);
  assert.match((await askRoomSeed({ url, room: 'SHARE' })).error, /no original ROM/);
  host.stop();
  await new Promise((r) => setTimeout(r, 100));
  assert.match((await askRoomSeed({ url, room: 'SHARE' })).error, /Nobody/);
  server.close();
});

test('deflate keeps a seed patch small enough for the room', async () => {
  const base = fakeBase();
  const z = await deflate(createBps(base, fakeSeed(base)));
  assert.ok(patchMessages(z, 1).length <= 24);
});
