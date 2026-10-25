// Server side of a multiplayer room, with no transport attached: feed it
// messages, it returns what to send to whom. The Node server (server/index.js)
// wraps it in WebSockets; a Cloudflare Durable Object could wrap it the same way.
//
// Protocol (JSON messages):
//   client -> server
//     { t: 'hello', name }                 first message after connecting
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
//   server -> client
//     { t: 'welcome', you, players }       reply to hello
//     { t: 'players', players }            someone joined or left
//     { t: 'synced', state, seeded }       reply to sync: the room's progress
//     { t: 'ops', from, ops }              another player's unlocks
//     { t: 'pos', from, p }                another player's position
//     { t: 'owner', k, id, n }             id runs the enemies at k; n players are there
//     { t: 'mobs', from, k, d }            the enemies at k, from their owner
//     { t: 'hit', from, k, s, d }          to the owner: another player hit slot s
//     { t: 'tiles', from, k, b, c, f? }    surroundings another player changed
//     { t: 'error', message }
import { FIELDS, FIELD_BY_KEY, applyOp, validOp, emptyValue, isArrayKind } from './fields.js';

export const PROTOCOL_VERSION = 3;
const MAX_MOBS_B64 = 4096;
const MAX_TILE_PAIRS = 0x2000;
const MAX_PLAYERS = 8;
const MAX_NAME = 24;

export class Room {
  constructor(code, saved = null) {
    this.code = code;
    this.state = saved?.state ?? null;   // null until the first player syncs
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
    return [...this.players].map(([id, p]) => ({ id, name: p.name }));
  }

  message(id, msg) {
    const err = (message) => [{ to: id, msg: { t: 'error', message } }];
    if (!this.players.has(id) || !msg || typeof msg !== 'object') return err('bad message');
    switch (msg.t) {
      case 'hello': {
        const name = String(msg.name ?? '').trim().slice(0, MAX_NAME);
        if (name) this.players.get(id).name = name;
        return [
          { to: id, msg: { t: 'welcome', you: id, room: this.code, players: this.playerList(), v: PROTOCOL_VERSION } },
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
          this.state[op.k] = applyOp(f, this.state[op.k], op);
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

  toJSON() { return { code: this.code, state: this.state }; }
}

// Accept a client's snapshot only in the exact shape fields.js describes.
function cleanState(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const f of FIELDS) {
    const v = s[f.key];
    if (isArrayKind(f)) {
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
