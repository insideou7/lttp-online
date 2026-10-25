// A small server-side WebSocket (RFC 6455) for text messages, so the sync
// server needs no npm packages. Handles masking, fragmentation, ping/pong and
// close; rejects binary data and messages over 256 KiB.
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 256 * 1024;

// Completes the HTTP upgrade. Returns { send, close, onmessage, onclose } or
// null if the request isn't a valid WebSocket handshake.
export function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);

  const ws = { onmessage: () => {}, onclose: () => {}, send, close };
  let buf = Buffer.alloc(0);
  let parts = [];
  let partsLen = 0;
  let closed = false;

  function frame(opcode, payload) {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, n])
      : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    return Buffer.concat([head, payload]);
  }
  function send(text) {
    if (!closed && socket.writable) socket.write(frame(1, Buffer.from(text)));
  }
  function close(code = 1000) {
    if (closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    if (socket.writable) socket.write(frame(8, p));
    socket.end();
    finish();
  }
  function finish() {
    if (closed) return;
    closed = true;
    ws.onclose();
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (!closed) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, opcode = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return close(1009);
        len = Number(big); off = 10;
      }
      if (!masked) return close(1002);  // clients must mask
      if (len > MAX_MESSAGE) return close(1009);
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);

      if (opcode === 8) return close();
      if (opcode === 9) { socket.write(frame(10, payload)); continue; }
      if (opcode === 10) continue;
      if (opcode === 2) return close(1003);  // binary not supported
      if (opcode === 1 || opcode === 0) {
        parts.push(payload); partsLen += payload.length;
        if (partsLen > MAX_MESSAGE) return close(1009);
        if (fin) {
          const text = Buffer.concat(parts).toString('utf8');
          parts = []; partsLen = 0;
          ws.onmessage(text);
        }
        continue;
      }
      return close(1002);
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);

  // Keep idle connections alive through proxies.
  const ping = setInterval(() => {
    if (closed) return clearInterval(ping);
    if (socket.writable) socket.write(frame(9, Buffer.alloc(0)));
  }, 30000);
  ping.unref();
  return ws;
}
