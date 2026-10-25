// Cloudflare Workers version of the sync server (server/index.js is the Node one).
// Same endpoint: WebSocket at /sync?room=CODE, plus /healthz. Each room is one
// Durable Object running the shared Room logic from web/site/sync/room.js.
// Room progress is saved to the object's storage, so it survives the object
// being unloaded, and is deleted 12 hours after the last player leaves.
import { Room, isRoomCode } from '../../web/site/sync/room.js';

const LIVE = new Set(['pos', 'at', 'mobs', 'hit']);
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return new Response('ok');
    const code = (url.searchParams.get('room') || '').toUpperCase();
    if (!url.pathname.endsWith('/sync') || !isRoomCode(code)) {
      return new Response('Bad Request', { status: 400 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 });
    }
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  },
};

export class SyncRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.room = null;
    this.sockets = new Map();   // player id -> WebSocket
  }

  async fetch(request) {
    const code = new URL(request.url).searchParams.get('room').toUpperCase();
    if (!this.room) {
      const state = await this.ctx.storage.get('state');
      this.room = new Room(code, state ? { state } : null);
    }
    const id = this.room.connect();
    if (id === null) return new Response('Room Full', { status: 503 });
    await this.ctx.storage.deleteAlarm();

    const [client, ws] = Object.values(new WebSocketPair());
    ws.accept();
    this.sockets.set(id, ws);
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { ws.close(1003); return; }
      // Positions and enemies (most messages) never change the saved progress.
      if (LIVE.has(msg?.t)) { this.deliver(this.room.message(id, msg)); return; }
      const before = JSON.stringify(this.room.state);
      this.deliver(this.room.message(id, msg));
      const after = JSON.stringify(this.room.state);
      if (after !== before) this.ctx.storage.put('state', this.room.state);
    });
    const gone = () => {
      if (!this.sockets.delete(id)) return;
      this.deliver(this.room.disconnect(id));
      if (this.room.empty) this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    if (this.sockets.size) return;
    await this.ctx.storage.deleteAll();
    this.room = null;
  }

  deliver(out) {
    for (const { to, from, msg } of out) {
      const data = JSON.stringify(msg);
      for (const [id, ws] of this.sockets) {
        if (to === 'all' || (to === 'others' && id !== from) || to === id) {
          try { ws.send(data); } catch {}
        }
      }
    }
  }
}
