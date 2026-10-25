// BPS patches (the format byuu designed, also used by ALttPR and Flips):
// createBps(source, target) describes target as copies from source plus new
// bytes, and applyBps(source, patch) rebuilds target. A room shares a seed
// this way: the patch holds the randomizer's own changes, and each player
// rebuilds the seed from their own copy of the original game.
//
// Format: "BPS1", sizes, metadata, then actions; each action is a number
// ((length - 1) << 2 | kind), kind 0 = copy source at the same offset,
// 1 = new bytes follow, 2 = copy source from elsewhere, 3 = copy what was
// already written. It ends with CRC32s of source, target and the patch.

const SOURCE_READ = 0, TARGET_READ = 1, SOURCE_COPY = 2, TARGET_COPY = 3;
const MIN_COPY = 6;        // shorter matches cost more to describe than to include
const HASH_BITS = 18;
const MAX_CHAIN = 48;      // candidates tried per position

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class Writer {
  constructor(size = 1 << 16) { this.buf = new Uint8Array(size); this.n = 0; }
  byte(b) {
    if (this.n === this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.n++] = b;
  }
  bytes(src) { for (const b of src) this.byte(b); }
  num(v) {   // BPS variable-length number
    for (;;) {
      const x = v % 128;
      v = Math.floor(v / 128);
      if (v === 0) { this.byte(0x80 | x); return; }
      this.byte(x);
      v--;
    }
  }
  u32(v) { for (let i = 0; i < 4; i++) this.byte((v >>> (8 * i)) & 0xff); }
  done() { return this.buf.slice(0, this.n); }
}

const hashAt = (d, i) => (((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) * 2654435761 >>> (32 - HASH_BITS));

// Hash chains over `data`, like zlib's: head[h] is the latest position with
// hash h, prev[pos] the one before it.
function chains(len) {
  return { head: new Int32Array(1 << HASH_BITS).fill(-1), prev: new Int32Array(Math.max(len, 1)) };
}
function insert(c, data, i) {
  const h = hashAt(data, i);
  c.prev[i] = c.head[h];
  c.head[h] = i;
}
function longest(c, data, limit, target, t, tEnd) {
  let best = 0, at = -1, tries = MAX_CHAIN;
  for (let p = c.head[hashAt(target, t)]; p >= 0 && tries--; p = c.prev[p]) {
    let n = 0;
    const max = Math.min(tEnd - t, limit - p);
    while (n < max && data[p + n] === target[t + n]) n++;
    if (n > best) { best = n; at = p; if (n === max) break; }
  }
  return { len: best, at };
}

export function createBps(source, target, metadata = '') {
  const w = new Writer(1 << 18);
  w.bytes([0x42, 0x50, 0x53, 0x31]);   // "BPS1"
  w.num(source.length);
  w.num(target.length);
  const meta = new TextEncoder().encode(metadata);
  w.num(meta.length);
  w.bytes(meta);

  const src = chains(source.length);
  for (let i = 0; i + 4 <= source.length; i++) insert(src, source, i);
  const tgt = chains(target.length);
  let tgtIndexed = 0;   // target positions below this are in `tgt`

  let srcRel = 0, tgtRel = 0, litStart = -1;
  const flushLiterals = (end) => {
    if (litStart < 0) return;
    w.num(((end - litStart - 1) << 2) | TARGET_READ);
    w.bytes(target.subarray(litStart, end));
    litStart = -1;
  };
  const relative = (offset, from) => {
    const d = offset - from;
    w.num((Math.abs(d) << 1) | (d < 0 ? 1 : 0));
  };

  let t = 0;
  const n = target.length;
  while (t < n) {
    // Same bytes at the same offset: cheapest of all.
    let same = 0;
    while (t + same < n && t + same < source.length && source[t + same] === target[t + same]) same++;
    let kind = SOURCE_READ, len = same, at = t;
    if (same < 32 && t + 4 <= n) {
      const s = longest(src, source, source.length, target, t, n);
      if (s.len > len + 3) { kind = SOURCE_COPY; len = s.len; at = s.at; }
      while (tgtIndexed + 4 <= t) insert(tgt, target, tgtIndexed++);
      const c = longest(tgt, target, n, target, t, n);   // may overlap what it writes, like a run
      if (c.len > len + 3) { kind = TARGET_COPY; len = c.len; at = c.at; }
    }
    if (len < (kind === SOURCE_READ ? 4 : MIN_COPY)) {
      if (litStart < 0) litStart = t;
      t++;
      continue;
    }
    flushLiterals(t);
    w.num(((len - 1) << 2) | kind);
    if (kind === SOURCE_COPY) { relative(at, srcRel); srcRel = at + len; }
    if (kind === TARGET_COPY) { relative(at, tgtRel); tgtRel = at + len; }
    t += len;
  }
  flushLiterals(n);
  w.u32(crc32(source));
  w.u32(crc32(target));
  w.u32(crc32(w.buf.subarray(0, w.n)));
  return w.done();
}

// Facts from a patch's header, without applying it.
export function bpsInfo(patch) {
  const r = reader(patch);
  if (patch.length < 16 || r.byte() !== 0x42 || r.byte() !== 0x50 || r.byte() !== 0x53 || r.byte() !== 0x31) {
    throw new Error('Not a BPS patch.');
  }
  const sourceSize = r.num(), targetSize = r.num(), metaSize = r.num();
  const metadata = new TextDecoder().decode(patch.subarray(r.pos, r.pos + metaSize));
  r.pos += metaSize;
  const end = patch.length - 12;
  const u32 = (o) => (patch[o] | (patch[o + 1] << 8) | (patch[o + 2] << 16) | (patch[o + 3] << 24)) >>> 0;
  return { sourceSize, targetSize, metadata, actionsAt: r.pos, end,
    sourceCrc: u32(end), targetCrc: u32(end + 4), patchCrc: u32(end + 8) };
}

function reader(bytes) {
  const r = {
    pos: 0,
    byte: () => {
      if (r.pos >= bytes.length) throw new Error('The patch is cut short.');
      return bytes[r.pos++];
    },
    num: () => {
      let v = 0, shift = 1;
      for (;;) {
        const x = r.byte();
        v += (x & 0x7f) * shift;
        if (x & 0x80) return v;
        shift *= 128;
        v += shift;
      }
    },
  };
  return r;
}

// Rebuilds the target. Throws if the patch is damaged or made for another
// source file (err.wrongSource is then true).
export function applyBps(source, patch) {
  const info = bpsInfo(patch);
  if (crc32(patch.subarray(0, patch.length - 4)) !== info.patchCrc) throw new Error('The patch is damaged.');
  if (source.length !== info.sourceSize || crc32(source) !== info.sourceCrc) {
    throw Object.assign(new Error('This patch is for a different ROM.'), { wrongSource: true });
  }
  if (info.targetSize > 0x1000000) throw new Error('The patch makes a file that is too big.');
  const out = new Uint8Array(info.targetSize);
  const r = reader(patch.subarray(0, info.end));
  r.pos = info.actionsAt;
  let o = 0, srcRel = 0, tgtRel = 0;
  const signed = () => { const v = r.num(); return (v & 1 ? -1 : 1) * Math.floor(v / 2); };
  while (r.pos < info.end) {
    const cmd = r.num();
    const kind = cmd & 3, len = Math.floor(cmd / 4) + 1;
    if (o + len > out.length) throw new Error('The patch is damaged.');
    switch (kind) {
      case SOURCE_READ:
        if (o + len > source.length) throw new Error('The patch is damaged.');
        out.set(source.subarray(o, o + len), o);
        break;
      case TARGET_READ:
        if (r.pos + len > info.end) throw new Error('The patch is damaged.');
        out.set(patch.subarray(r.pos, r.pos + len), o);
        r.pos += len;
        break;
      case SOURCE_COPY:
        srcRel += signed();
        if (srcRel < 0 || srcRel + len > source.length) throw new Error('The patch is damaged.');
        out.set(source.subarray(srcRel, srcRel + len), o);
        srcRel += len;
        break;
      case TARGET_COPY:
        tgtRel += signed();
        if (tgtRel < 0 || tgtRel >= o) throw new Error('The patch is damaged.');
        for (let i = 0; i < len; i++) out[o + i] = out[tgtRel++];   // may overlap, byte by byte
        break;
    }
    o += len;
  }
  if (o !== out.length || crc32(out) !== info.targetCrc) throw new Error('The patch is damaged.');
  return out;
}

// Deflate for sending a patch; browsers and Node both have CompressionStream.
async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
export const deflate = (bytes) => pipe(bytes, new CompressionStream('deflate-raw'));
export const inflate = (bytes) => pipe(bytes, new DecompressionStream('deflate-raw'));
