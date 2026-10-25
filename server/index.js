// LTTP Online sync server: relays shared unlocks between players in a room.
//
//   node server/index.js [--static web/dist]       (PORT, default 8080)
//
// WebSocket endpoint: /sync?room=CODE. With --static it also serves the built
// site, so one process hosts everything on one origin. No npm dependencies.
// Rooms live in memory and are forgotten 12 hours after the last player leaves.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Room, isRoomCode } from '../web/site/sync/room.js';
import { acceptWebSocket } from './websocket.js';

const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

export function createServer({ staticDir = null } = {}) {
  const rooms = new Map();   // code -> { room, sockets: Map(id -> ws), timer }

  function getRoom(code) {
    let r = rooms.get(code);
    if (!r) {
      r = { room: new Room(code), sockets: new Map(), timer: null };
      rooms.set(code, r);
    }
    clearTimeout(r.timer);
    return r;
  }

  function deliver(r, out) {
    for (const { to, from, msg } of out) {
      const data = JSON.stringify(msg);
      for (const [id, ws] of r.sockets) {
        if (to === 'all' || (to === 'others' && id !== from) || to === id) ws.send(data);
      }
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return void res.end('ok');
    if (staticDir) return serveStatic(staticDir, url.pathname, res);
    res.writeHead(404).end('Not found');
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    const code = (url.searchParams.get('room') || '').toUpperCase();
    if (!url.pathname.endsWith('/sync') || !isRoomCode(code)) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const r = getRoom(code);
    const id = r.room.connect();
    if (id === null) {
      socket.end('HTTP/1.1 503 Room Full\r\n\r\n');
      return;
    }
    const ws = acceptWebSocket(req, socket);
    if (!ws) { deliver(r, r.room.disconnect(id)); return; }
    r.sockets.set(id, ws);
    ws.onmessage = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return ws.close(1003); }
      deliver(r, r.room.message(id, msg));
    };
    ws.onclose = () => {
      r.sockets.delete(id);
      deliver(r, r.room.disconnect(id));
      if (r.room.empty) r.timer = setTimeout(() => rooms.delete(code), ROOM_TTL_MS).unref();
    };
  });

  return { server, rooms };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8', '.ini': 'text/plain; charset=utf-8', '.png': 'image/png',
  '.zip': 'application/zip', '.whl': 'application/octet-stream', '.bin': 'application/octet-stream',
};

function serveStatic(root, pathname, res) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return void res.writeHead(400).end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(path.resolve(root) + path.sep)) return void res.writeHead(403).end();
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return void res.writeHead(404).end('Not found');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
    });
    fs.createReadStream(file).pipe(res);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--static');
  const staticDir = i > 0 ? path.resolve(process.argv[i + 1]) : null;
  const port = Number(process.env.PORT) || 8080;
  const { server } = createServer({ staticDir });
  server.listen(port, () => {
    console.log(`LTTP Online sync server on http://localhost:${port}` +
      (staticDir ? ` (serving ${staticDir})` : '') + ', WebSocket at /sync');
  });
}
