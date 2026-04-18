/**
 * Git delta codec.
 *
 * Git uses a binary diff format for pack-file delta compression.
 * A delta encodes a "target" object as a sequence of instructions
 * that reference a "base" object:
 *
 *   Header
 *     varint: source (base) size
 *     varint: target size
 *
 *   Instructions
 *     COPY  (bit 7 = 1):
 *       bits 0-3: which of the 4 offset bytes follow
 *       bits 4-6: which of the 3 size bytes follow
 *       (absent bytes are 0)
 *       if size == 0, treat as 0x10000
 *     INSERT (bit 7 = 0, low 7 bits = count):
 *       count bytes of literal data follow directly
 */

// ---- variable-length integer -----------------------------------------------

function readVarint(buf: Buffer, pos: number): [value: number, nextPos: number] {
  let val = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = buf[pos++];
    val |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return [val, pos];
}

// ---- delta application -----------------------------------------------------

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;

  const [srcSize, p1] = readVarint(delta, pos);
  pos = p1;
  if (base.length !== srcSize) {
    throw new Error(`Delta base size mismatch: expected ${srcSize}, got ${base.length}`);
  }

  const [dstSize, p2] = readVarint(delta, pos);
  pos = p2;

  const result = Buffer.allocUnsafe(dstSize);
  let out = 0;

  while (pos < delta.length) {
    const cmd = delta[pos++];

    if (cmd & 0x80) {
      // ---- COPY instruction ------------------------------------------------
      let offset = 0;
      let size   = 0;

      if (cmd & 0x01) { offset |= delta[pos++]; }
      if (cmd & 0x02) { offset |= delta[pos++] << 8; }
      if (cmd & 0x04) { offset |= delta[pos++] << 16; }
      if (cmd & 0x08) { offset |= delta[pos++] << 24; }

      if (cmd & 0x10) { size |= delta[pos++]; }
      if (cmd & 0x20) { size |= delta[pos++] << 8; }
      if (cmd & 0x40) { size |= delta[pos++] << 16; }

      if (size === 0) size = 0x10000;

      if (offset + size > base.length) {
        throw new Error(`Delta COPY out of range: offset=${offset} size=${size} base=${base.length}`);
      }
      base.copy(result, out, offset, offset + size);
      out += size;

    } else if (cmd) {
      // ---- INSERT instruction ----------------------------------------------
      const count = cmd; // low 7 bits (bit 7 = 0, so cmd IS the count)
      if (pos + count > delta.length) {
        throw new Error(`Delta INSERT overflows delta buffer`);
      }
      delta.copy(result, out, pos, pos + count);
      pos += count;
      out += count;

    } else {
      throw new Error('Invalid delta instruction: 0x00');
    }
  }

  if (out !== dstSize) {
    throw new Error(`Delta result size mismatch: expected ${dstSize}, got ${out}`);
  }

  return result;
}
