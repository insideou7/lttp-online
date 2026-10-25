// Browser side of multiplayer: watches this player's save area, sends new
// unlocks to the room and writes other players' unlocks into the game.
//
// It talks to the game only through a backend object, so the same client
// works for zelda3 and a future SNES emulator core:
//   backend.ram.get(addr) / backend.ram.set(addr, byte)
//                       work RAM, addr is an offset from $7E0000
//   backend.inGame()    true while a save file is loaded and being played
//   backend.refresh(kinds)  optional: redraw after a remote change, kinds is a
//                       Set of 'hud' | 'sword' | 'shield' | 'armor'
//   backend.video       optional: video memory, to show this player's Link to
//                       the others (see presence.js). Without it the player
//                       still sees the others.
import { FIELDS, FIELD_BY_KEY, applyOp, diff, snapshot, describeOp } from './fields.js';
import { PresenceSender, RemotePlayers } from './presence.js';

const TICK_MS = 100;
const PRESENCE_MS = 66;   // position updates: 15 a second, only when something moved
const same = (a, b) => (Array.isArray(a) ? a.every((x, i) => x === b[i]) : a === b);

export class SyncClient {
  constructor({ url, room, name, backend, onStatus = () => {}, onNotice = () => {}, WebSocketImpl = globalThis.WebSocket }) {
    Object.assign(this, { url, room, name, backend, onStatus, onNotice, WebSocketImpl });
    this.ws = null;
    this.you = null;
    this.players = [];
    this.known = null;       // room state as far as this client knows; null = not synced
    this.offline = null;     // `known` from before a disconnect, to recover gains made offline
    this.syncSent = false;
    this.retryMs = 1000;
    this.closed = false;
    this.pendingRefresh = new Set();
    this.timer = null;
    this.serverVersion = 0;
    this.presence = backend.video ? new PresenceSender(backend) : null;
    this.remote = new RemotePlayers();   // other players' Links, for drawing
  }

  start() {
    this.connect();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.presenceTimer = setInterval(() => this.presenceTick(), PRESENCE_MS);
  }

  stop() {
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.presenceTimer);
    this.ws?.close();
  }

  status(state, detail = '') { this.onStatus({ state, detail, players: this.players, you: this.you }); }

  connect() {
    if (this.closed) return;
    const u = new URL(this.url);
    u.searchParams.set('room', this.room);
    let ws;
    try {
      ws = new this.WebSocketImpl(u.toString());
    } catch (e) {
      this.status('error', e.message);
      return;
    }
    this.ws = ws;
    this.status('connecting');
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.retryMs = 1000;
      this.send({ t: 'hello', name: this.name });
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.known) this.offline = this.known;
      this.known = null;
      this.remote.clear();
      this.syncSent = false;
      if (this.closed) return;
      this.status(opened ? 'reconnecting' : 'unreachable');
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 30000);
    };
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  playerName(id) {
    return this.players.find((p) => p.id === id)?.name ?? 'Someone';
  }

  onMessage(msg) {
    switch (msg.t) {
      case 'welcome':
        this.you = msg.you;
        this.players = msg.players;
        this.serverVersion = msg.v ?? 1;
        this.presence?.reset();
        this.status('connected');
        break;
      case 'players':
        this.players = msg.players;
        // A newcomer needs our position and pose images again.
        this.presence?.reset();
        this.remote.retain(msg.players.map((p) => p.id));
        this.status('connected');
        break;
      case 'pos':
        this.remote.onPos(msg.from, msg.p);
        break;
      case 'synced':
        this.onSynced(msg.state);
        break;
      case 'ops':
        this.onRemoteOps(msg.from, msg.ops);
        break;
      case 'error':
        console.warn('[sync] server:', msg.message);
        break;
    }
  }

  // The room's progress arrived: merge it with this player's save.
  onSynced(state) {
    this.syncSent = false;
    if (!this.backend.inGame()) return;  // left the game meanwhile; sync again later
    const ram = this.backend.ram;
    if (!snapshot(ram)) return;  // mid-transition; the next tick asks again
    for (const f of FIELDS) {
      const local = f.read(ram);
      // A server from an older version may not know a field yet: keep ours.
      const room = state[f.key] ?? (state[f.key] = local);
      const before = this.offline?.[f.key];
      let want;
      switch (f.kind) {
        case 'bits': want = local.map((b, i) => b | room[i]); break;
        case 'max': want = Math.max(local, room); break;
        // Keep a value this player changed while disconnected, else take the room's.
        case 'set': want = before !== undefined && local !== before ? local : room; break;
        // Room total plus whatever this player gained while disconnected.
        case 'sum': want = Math.min(f.max ?? 255, room + (before !== undefined ? Math.max(0, local - before) : 0)); break;
        // Room counts plus whatever this player picked up or used while disconnected.
        case 'counts': want = room.map((r, i) => Math.max(0, Math.min(f.max, r + (before ? local[i] - before[i] : 0)))); break;
      }
      if (!same(want, local)) {
        f.write(ram, want);
        if (f.refresh) this.pendingRefresh.add(f.refresh);
      }
    }
    this.known = structuredClone(state);
    this.offline = null;
    // The next tick sends whatever this player has that the room didn't.
    this.tick();
  }

  onRemoteOps(from, ops) {
    if (!this.known || !this.backend.inGame()) return;  // the next sync picks them up
    const ram = this.backend.ram;
    for (const op of ops) {
      const f = FIELD_BY_KEY[op.k];
      if (!f) continue;
      this.known[f.key] = applyOp(f, this.known[f.key], op);
      if (f.kind === 'counts') {
        // Works even mid-transition, when the field can't be read.
        for (const [i, d] of Object.entries(op.d)) f.addAt(ram, Number(i), d);
        if (f.refresh) this.pendingRefresh.add(f.refresh);
        const what = describeOp(op);
        if (what) this.onNotice({ from, name: this.playerName(from), what, op });
        continue;
      }
      const cur = f.read(ram);
      const next = f.kind === 'set' ? op.v : applyOp(f, cur, op);
      if (!same(next, cur)) {
        f.write(ram, next);
        if (f.refresh) this.pendingRefresh.add(f.refresh);
      }
      const what = describeOp(op, f.kind === 'max' || f.kind === 'set' ? op.v : null);
      if (what) this.onNotice({ from, name: this.playerName(from), what, op });
    }
  }

  // Where this player's Link is and what he looks like (servers from before
  // protocol 2 don't relay it).
  presenceTick() {
    if (!this.presence || this.serverVersion < 2 || !this.ws || this.ws.readyState !== 1) return;
    const p = this.presence.next();
    if (p !== undefined) this.send({ t: 'pos', p });
  }

  tick() {
    if (!this.backend.inGame()) {
      // Back at the file select screen: the next file may be a different save.
      this.known = null;
      this.offline = null;
      return;
    }
    if (!this.ws || this.ws.readyState !== 1) return;
    if (!this.known) {
      const state = this.syncSent ? null : snapshot(this.backend.ram);
      if (state) {
        this.send({ t: 'sync', state });
        this.syncSent = true;
      }
      return;
    }
    const ram = this.backend.ram;
    const ops = [];
    for (const f of FIELDS) {
      const local = f.read(ram);
      if (local === null) continue;  // mid-transition
      const known = this.known[f.key];
      for (const op of diff(f, known, local)) {
        ops.push(op);
        this.known[f.key] = applyOp(f, known, op);
      }
      // Put back shared unlocks the game overwrote, e.g. a dungeon room's
      // flags saved from the copy the game loaded before another player
      // opened a chest there.
      if (f.kind === 'bits' || f.kind === 'max') {
        const want = applyOp(f, local, f.kind === 'bits'
          ? { bits: Object.fromEntries(this.known[f.key].map((m, i) => [i, m])) }
          : { v: this.known[f.key] });
        if (!same(want, local)) {
          f.write(ram, want);
          if (f.refresh) this.pendingRefresh.add(f.refresh);
        }
      }
    }
    if (ops.length) this.send({ t: 'ops', ops });
    if (this.pendingRefresh.size && this.backend.refresh) {
      if (this.backend.refresh(this.pendingRefresh) !== false) this.pendingRefresh.clear();
    }
  }
}

// Where the sync server is: ?server=..., else the deploy's build.json "sync"
// field, else /sync on the page's own host.
export function resolveSyncUrl(buildInfo, location = globalThis.location) {
  const param = new URL(location.href).searchParams.get('server');
  if (param) return param;
  if (buildInfo?.sync) return new URL(buildInfo.sync, location.href).toString().replace(/^http/, 'ws');
  return new URL('sync', location.href).toString().replace(/^http/, 'ws');
}
