// Server side of a multiplayer room, with no transport attached: feed it
// messages, it returns what to send to whom. The Node server (server/index.js)
// wraps it in WebSockets; a Cloudflare Durable Object could wrap it the same way.
//
// Protocol (JSON messages):
//   client -> server
//     { t: 'hello', name, game?, share? }  first message after connecting; game =
//                                          { id, label } of the ROM played (v4+;
//                                          clients before that play the US game);
//                                          share = it can send the seed (v5+)
//     { t: 'sync', state }                 player is in game with this save;
//                                          seeds the room if it has no state yet
//     { t: 'ops', ops: [...] }             player's own new unlocks (see fields.js)
//     { t: 'pos', p }                      where this player's Link is (presence.js),
//                                          p = { l, x, y, f, img? } or null; v2+
//     { t: 'at', k }                       which room/area this player's enemies
//                                          belong to (mobs.js), or null; v3+
//     { t: 'mobs', k, d }                  owner of k: its enemies (base64 bytes)
//     { t: 'hit', k, s, d, n? }            non-owner: it hit enemy slot s (bytes),
//                                          or made a new sprite there (n)
//     { t: 'tiles', k, b, c, f? }          surroundings changed (tiles.js) at place b:
//                                          pairs of RAM address and byte; f = all so far
//     { t: 'dlg', k, d }                   a text box is up (dialogs.js): d = the box,
//                                          deflated, base64; null = closed. k = the
//                                          area the player was last in; v6+
//   Seed sharing (v5+, see seed-share.js). A page that hasn't joined yet asks
//   what the room plays; a player who has the seed sends it as a patch against
//   the original game, so no ROM ever goes through the server:
//     { t: 'seed-get', have: [ids] }       before hello: what does the room play?
//                                          have = game ids this page already has
//     { t: 'seed-part', to, i, n, d }      player -> asker: part i of n of the patch
//     { t: 'seed-fail', to, why }          player -> asker: it can't send the patch
//   server -> client
//     { t: 'welcome', you, players, game } reply to hello
//     { t: 'wrong-game', game }            reply to hello: the room plays another
//                                          game or seed; the player isn't let in
//     { t: 'players', players }            someone joined or left
//     { t: 'synced', state, seeded }       reply to sync: the room's progress
//     { t: 'ops', from, ops }              another player's unlocks
//     { t: 'pos', from, p }                another player's position
//     { t: 'owner', k, id, n }             id runs the enemies at k; n players are there
//     { t: 'mobs', from, k, d }            the enemies at k, from their owner
//     { t: 'hit', from, k, s, d }          to the owner: another player hit slot s
//     { t: 'tiles', from, k, b, c, f? }    surroundings another player changed
//     { t: 'dlg', from, k, d }             another player's text box, to the players at k
//     { t: 'seed-info', game, sending }    reply to seed-get; sending = a player was
//                                          asked to send the patch (false: nobody can)
//     { t: 'seed-want', to }               to a sharing player: send the patch to `to`
//     { t: 'seed-part', i, n, d }          to the asker, from that player
//     { t: 'seed-fail', why }
//     { t: 'error', message }
import { FIELDS, FIELD_BY_KEY, applyOp, validOp, emptyValue, isArrayKind } from './fields.js';

export const PROTOCOL_VERSION = 6;
// What clients from before protocol 4 play (only zelda3, the US game, existed).
export const VANILLA_GAME = { id: 'lttp-us', label: 'A Link to the Past (US)' };
const MAX_MOBS_B64 = 4096;
const MAX_TILE_PAIRS = 0x2000;
const MAX_DLG_B64 = 8192;   // a deflated text box is usually under 2 KB
const MAX_PLAYERS = 8;
const MAX_NAME = 24;
// A shared seed's patch: an ALttPR seed's is about 90 KB deflated, so this
// leaves lots of room while keeping whole ROMs (or worse) from being relayed.
const MAX_SEED_PART_B64 = 64 * 1024;
const MAX_SEED_PARTS = 24;
const MAX_SEED_GETS = 20;   // per connection

export class Room {
  constructor(code, saved = null) {
    this.code = code;
    this.state = saved?.state ?? null;   // null until the first player syncs
    // Which ROM the room plays ({ id, label }, see web/site/rom-info.js): set by
    // the first player, kept with the progress. Everyone must play the same
    // seed, since item locations and progress flags only make sense in it.
    this.game = saved?.game ?? null;
    this.players = new Map();             // id -> { name, at }
    this.owners = new Map();              // enemy area key -> player id running them
    this.nextId = 1;
  }

  get empty() { return this.players.size === 0; }

  // Adds a connection and returns its player id, or null if the room is full.
  // message() and disconnect() return what to send as a list of
  // { to: id | 'all' | 'others', from?, msg }; 'others' means everyone but `from`.
  connect() {
    if (this.players.size >= MAX_PLAYERS) return null;
    const id = this.nextId++;
    this.players.set(id, { name: `Player ${id}` });
    return id;
  }

  disconnect(id) {
    const p = this.players.get(id);
    if (!p) return [];
    const out = this.moveTo(id, null);
    this.players.delete(id);
    if (!p.joined) return out;   // only asked about the seed, or was turned away
    return [...out, { to: 'all', msg: { t: 'players', players: this.playerList() } }];
  }

  // Enemies: in each area (a dungeon room or overworld screen, see mobs.js) one
  // player, the first to arrive, runs the enemies and the others copy them.
  // When the owner leaves, the longest-present player still there takes over.
  playersAt(k) {
    return [...this.players].filter(([, p]) => p.at === k).map(([id]) => id);
  }

  moveTo(id, k) {
    const p = this.players.get(id);
    const old = p.at ?? null;
    if (old === k) return [];
    p.at = k;
    if (k !== null) p.was = k;   // where a paused player (e.g. reading text) still is
    const out = [];
    if (old !== null) {
      const left = this.playersAt(old);
      if (this.owners.get(old) === id) {
        if (left.length) this.owners.set(old, left[0]); else this.owners.delete(old);
      }
      out.push(...this.ownerNotice(old));
    }
    if (k !== null) {
      if (!this.owners.has(k)) this.owners.set(k, id);
      out.push(...this.ownerNotice(k));
    }
    return out;
  }

  ownerNotice(k) {
    const ids = this.playersAt(k);
    const msg = { t: 'owner', k, id: this.owners.get(k) ?? null, n: ids.length };
    return ids.map((to) => ({ to, msg }));
  }

  playerList() {
    return [...this.players].filter(([, p]) => p.joined).map(([id, p]) => ({ id, name: p.name }));
  }

  message(id, msg) {
    const err = (message) => [{ to: id, msg: { t: 'error', message } }];
    if (!this.players.has(id) || !msg || typeof msg !== 'object') return err('bad message');
    switch (msg.t) {
      case 'hello': {
        const game = cleanGame(msg.game) ?? VANILLA_GAME;
        const othersHere = [...this.players.values()].some((p) => p.joined);
        // A room with no progress and nobody in it can switch to a new game.
        if (!this.game || (!this.state && !othersHere)) this.game = game;
        else if (this.game.id !== game.id) {
          this.players.delete(id);
          return [
            { to: id, msg: { t: 'wrong-game', game: this.game } },
            { to: id, msg: { t: 'error', message: `This room is playing ${this.game.label}.` } },
          ];
        }
        const p = this.players.get(id);
        p.joined = true;
        p.share = msg.share === true;
        const name = String(msg.name ?? '').trim().slice(0, MAX_NAME);
        if (name) p.name = name;
        return [
          { to: id, msg: { t: 'welcome', you: id, room: this.code, players: this.playerList(), game: this.game, v: PROTOCOL_VERSION } },
          { to: 'others', from: id, msg: { t: 'players', players: this.playerList() } },
        ];
      }
      case 'sync': {
        let seeded = false;
        if (!this.state) {
          const s = cleanState(msg.state);
          if (!s) return err('bad state');
          this.state = s;
          seeded = true;
        }
        return [{ to: id, msg: { t: 'synced', state: this.state, seeded } }];
      }
      case 'ops': {
        if (!this.state) return err('room has no state yet; send sync first');
        if (!Array.isArray(msg.ops)) return err('bad ops');
        const ops = msg.ops.filter(validOp);
        for (const op of ops) {
          const f = FIELD_BY_KEY[op.k];
          this.state[op.k] = applyOp(f, this.state[op.k] ?? emptyValue(f), op);
        }
        if (!ops.length) return [];
        return [{ to: 'others', from: id, msg: { t: 'ops', from: id, ops } }];
      }
      case 'pos': {
        // Relayed only, never stored: senders repeat theirs when someone joins.
        const p = cleanPos(msg.p);
        if (p === undefined) return err('bad pos');
        return [{ to: 'others', from: id, msg: { t: 'pos', from: id, p } }];
      }
      case 'at': {
        const k = msg.k === null ? null : areaKey(msg.k);
        if (k === undefined) return err('bad area');
        return this.moveTo(id, k);
      }
      case 'mobs': {
        // Only the owner's copy counts; anything else is stale.
        const k = areaKey(msg.k);
        if (k === undefined || this.owners.get(k) !== id || !isB64(msg.d)) return [];
        return this.playersAt(k).filter((to) => to !== id)
          .map((to) => ({ to, msg: { t: 'mobs', from: id, k, d: msg.d } }));
      }
      case 'tiles': {
        const k = areaKey(msg.k);
        const c = msg.c;
        const b = msg.b === undefined ? k : areaKey(msg.b);
        if (k === undefined || b === undefined || this.players.get(id).at !== k) return [];
        if (!Array.isArray(c) || c.length % 2 || c.length > MAX_TILE_PAIRS * 2 ||
            !c.every((v, i) => int(v, 0, i % 2 ? 0xff : 0x1ffff))) return err('bad tiles');
        return this.playersAt(k).filter((to) => to !== id)
          .map((to) => ({ to, msg: { t: 'tiles', from: id, k, b, c, ...(msg.f ? { f: 1 } : {}) } }));
      }
      case 'dlg': {
        // Sent while the game is paused for the text, so the player's area
        // reads null: the box goes to the area they were last in.
        const k = areaKey(msg.k);
        const d = msg.d;
        if (k === undefined || this.players.get(id).was !== k) return [];
        if (d !== null && !(typeof d === 'string' && d.length <= MAX_DLG_B64 && /^[A-Za-z0-9+/]*=*$/.test(d))) return err('bad dlg');
        return this.playersAt(k).filter((to) => to !== id)
          .map((to) => ({ to, msg: { t: 'dlg', from: id, k, d } }));
      }
      case 'seed-get': {
        const p = this.players.get(id);
        if (p.joined || (p.gets = (p.gets ?? 0) + 1) > MAX_SEED_GETS) return [];
        const have = Array.isArray(msg.have) ? msg.have : [];
        // The US game runs on zelda3 from the player's own ROM; nothing to send.
        if (!this.game || this.game.id === VANILLA_GAME.id || have.includes(this.game.id)) {
          return [{ to: id, msg: { t: 'seed-info', game: this.game, sending: false } }];
        }
        // Ask the sharer who has been here longest, a different one each time
        // this page asks again in case one of them couldn't send it.
        const sharers = [...this.players].filter(([, q]) => q.joined && q.share).map(([pid]) => pid);
        const from = sharers.length ? sharers[(p.gets - 1) % sharers.length] : null;
        return [
          { to: id, msg: { t: 'seed-info', game: this.game, sending: from !== null } },
          ...(from !== null ? [{ to: from, msg: { t: 'seed-want', to: id } }] : []),
        ];
      }
      case 'seed-part': case 'seed-fail': {
        const p = this.players.get(id), to = this.players.get(msg.to);
        // Only a player in the room, to a page that's still just asking.
        if (!p.joined || !p.share || !to || to.joined || !to.gets) return [];
        if (msg.t === 'seed-fail') {
          const why = typeof msg.why === 'string' ? msg.why.replace(/[^\x20-\x7e]/g, '').slice(0, 200) : '';
          return [{ to: msg.to, msg: { t: 'seed-fail', why } }];
        }
        if (!int(msg.n, 1, MAX_SEED_PARTS) || !int(msg.i, 0, msg.n - 1) || typeof msg.d !== 'string' ||
            msg.d.length > MAX_SEED_PART_B64 || !/^[A-Za-z0-9+/]*=*$/.test(msg.d)) return err('bad seed part');
        return [{ to: msg.to, msg: { t: 'seed-part', i: msg.i, n: msg.n, d: msg.d } }];
      }
      case 'hit': {
        const k = areaKey(msg.k);
        const owner = this.owners.get(k);
        if (k === undefined || owner === undefined || owner === id || this.players.get(id).at !== k) return [];
        if (!int(msg.s, 0, 15) || !isB64(msg.d)) return err('bad hit');
        return [{ to: owner, msg: { t: 'hit', from: id, k, s: msg.s, d: msg.d, ...(msg.n ? { n: 1 } : {}) } }];
      }
    }
    return err('unknown message type');
  }

  toJSON() { return { code: this.code, state: this.state, game: this.game }; }
}

// A game in the shape rom-info.js describes, or null.
function cleanGame(g) {
  if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !/^[\x20-\x7e]{1,80}$/.test(g.id)) return null;
  const label = typeof g.label === 'string' ? g.label.replace(/[^\x20-\x7e]/g, '').slice(0, 80) : '';
  return { id: g.id, label: label || g.id };
}

// Accept a client's snapshot only in the exact shape fields.js describes.
// A field the client doesn't know yet (an older page) starts out empty.
function cleanState(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const f of FIELDS) {
    const v = s[f.key];
    if (isArrayKind(f)) {
      if (v === undefined) { out[f.key] = emptyValue(f); continue; }
      if (!Array.isArray(v) || v.length !== f.len) return null;
      out[f.key] = v.map((b) => (Number.isInteger(b) ? Math.max(0, Math.min(f.max ?? 255, b)) : 0));
    } else {
      out[f.key] = Number.isInteger(v) ? Math.max(0, Math.min(f.max ?? 255, v)) : emptyValue(f);
    }
  }
  return out;
}

const areaKey = (k) => (typeof k === 'string' && /^[a-z0-9]{1,8}$/.test(k) ? k : undefined);
const isB64 = (d) => typeof d === 'string' && d.length <= MAX_MOBS_B64 && /^[A-Za-z0-9+/]*=*$/.test(d);

// A position in the shape presence.js sends, or undefined if it isn't one.
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
function cleanPos(p) {
  if (p === null) return null;
  if (!p || typeof p !== 'object') return undefined;
  if (typeof p.l !== 'string' || !/^[a-z0-9]{1,4}$/.test(p.l)) return undefined;
  if (!int(p.x, 0, 0xffff) || !int(p.y, 0, 0xffff)) return undefined;
  if (typeof p.f !== 'string' || !/^[a-z0-9]{1,8}$/.test(p.f)) return undefined;
  const out = { l: p.l, x: p.x, y: p.y, f: p.f };
  if (p.img !== undefined) {
    const i = p.img;
    if (!i || !int(i.ox, -64, 64) || !int(i.oy, -64, 64) || !int(i.w, 1, 64) || !int(i.h, 1, 64)) return undefined;
    if (!Array.isArray(i.c) || i.c.length > 255 || !i.c.every((c) => int(c, 0, 0x7fff))) return undefined;
    if (typeof i.p !== 'string' || i.p.length !== Math.ceil((i.w * i.h) / 3) * 4 || !/^[A-Za-z0-9+/]*=*$/.test(i.p)) return undefined;
    out.img = { ox: i.ox, oy: i.oy, w: i.w, h: i.h, c: i.c.slice(), p: i.p };
  }
  return out;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no I, O, 0, 1
export function isRoomCode(code) {
  return typeof code === 'string' && /^[A-HJ-NP-Z2-9]{4,12}$/.test(code);
}
export function newRoomCode(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
