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
//   server -> client
//     { t: 'welcome', you, players }       reply to hello
//     { t: 'players', players }            someone joined or left
//     { t: 'synced', state, seeded }       reply to sync: the room's progress
//     { t: 'ops', from, ops }              another player's unlocks
//     { t: 'error', message }
import { FIELDS, FIELD_BY_KEY, applyOp, validOp, emptyValue } from './fields.js';

export const PROTOCOL_VERSION = 1;
const MAX_PLAYERS = 8;
const MAX_NAME = 24;

export class Room {
  constructor(code, saved = null) {
    this.code = code;
    this.state = saved?.state ?? null;   // null until the first player syncs
    this.players = new Map();             // id -> { name }
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
    if (!this.players.delete(id)) return [];
    return [{ to: 'all', msg: { t: 'players', players: this.playerList() } }];
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
    if (f.kind === 'bits') {
      if (!Array.isArray(v) || v.length !== f.len) return null;
      out[f.key] = v.map((b) => (Number.isInteger(b) ? b & 0xff : 0));
    } else {
      out[f.key] = Number.isInteger(v) ? Math.max(0, Math.min(f.max ?? 255, v)) : emptyValue(f);
    }
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
