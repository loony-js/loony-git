/**
 * Pack-file reader and writer.
 *
 * Format:
 *   Header:  "PACK" | version(4B BE) | count(4B BE)
 *   Objects: [variable-length header] [type-specific data] ...
 *   Trailer: SHA-1(all preceding bytes) — 20 bytes
 *
 * Object header encoding:
 *   byte 0: MSB(more) | type[2:0](bits 6:4) | size[3:0](bits 3:0)
 *   byte N: MSB(more) | size[6:0]
 *
 * Object types:
 *   1 commit  2 tree  3 blob  4 tag
 *   6 ofs_delta  7 ref_delta
 *
 * OFS_DELTA offset is a modified-base-128 negative offset:
 *   n = first_byte & 0x7F
 *   while (byte & 0x80): n = ((n+1) << 7) | (next_byte & 0x7F)
 *
 * REF_DELTA: 20-byte base SHA-1 precedes the zlib data.
 */

import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { ObjectType } from '../../types';
import { applyDelta } from './delta';
import { ObjectStore } from '../objects/store';

const PACK_MAGIC = Buffer.from('PACK');
const PACK_VERSION = 2;

const TYPE_NUM: Record<string, number> = { commit:1, tree:2, blob:3, tag:4 };
const NUM_TYPE: Record<number, ObjectType | 'ofs_delta' | 'ref_delta'> = {
  1:'commit', 2:'tree', 3:'blob', 4:'tag', 6:'ofs_delta', 7:'ref_delta',
};

// ---- resolved object -------------------------------------------------------

export interface PackObject {
  sha:     string;
  type:    ObjectType;
  content: Buffer;
}

// ---- reader ----------------------------------------------------------------

export class PackfileReader {

  /**
   * Parse a complete pack buffer, resolve all deltas, and return all objects.
   * Pass an ObjectStore so REF_DELTA bases that are NOT in the pack
   * (thin-pack scenario) can be resolved from loose storage.
   */
  static parse(pack: Buffer, store?: ObjectStore): PackObject[] {

    if (!pack.subarray(0, 4).equals(PACK_MAGIC)) {
      throw new Error('Not a valid pack file (missing PACK signature)');
    }
    const version = pack.readUInt32BE(4);
    if (version !== 2) throw new Error(`Unsupported pack version: ${version}`);

    const count = pack.readUInt32BE(8);
    let pos = 12;

    // First pass — read raw (pre-delta) objects
    interface RawObject {
      offset: number;
      type:   number;       // numeric type from pack header
      data:   Buffer;       // zlib-inflated
      // OFS_DELTA: negative offset relative to this object's start
      baseOffset?: number;
      // REF_DELTA: base SHA
      baseSha?: string;
    }

    const rawByOffset = new Map<number, RawObject>();
    const rawList: RawObject[] = [];

    for (let i = 0; i < count; i++) {
      const offset = pos;

      // --- parse variable-length header ---
      let byte  = pack[pos++];
      const typeNum = (byte >> 4) & 0x07;
      let size  = byte & 0x0f;
      let shift = 4;
      while (byte & 0x80) {
        byte  = pack[pos++];
        size |= (byte & 0x7f) << shift;
        shift += 7;
      }

      let baseOffset: number | undefined;
      let baseSha: string | undefined;

      if (typeNum === 6) {
        // OFS_DELTA — read the negative offset
        byte = pack[pos++];
        let ofs = byte & 0x7f;
        while (byte & 0x80) {
          byte = pack[pos++];
          ofs = ((ofs + 1) << 7) | (byte & 0x7f);
        }
        baseOffset = ofs;
      } else if (typeNum === 7) {
        // REF_DELTA — read 20-byte base SHA
        baseSha = pack.subarray(pos, pos + 20).toString('hex');
        pos += 20;
      }

      // --- inflate the zlib-compressed data ---
      const inflated = inflateAt(pack, pos);
      pos += inflated.consumed;

      const raw: RawObject = {
        offset, type: typeNum,
        data: inflated.data,
        baseOffset, baseSha,
      };
      rawByOffset.set(offset, raw);
      rawList.push(raw);
    }

    // Second pass — resolve deltas recursively
    const resolved = new Map<number, PackObject>();

    const resolveAt = (offset: number): PackObject => {
      if (resolved.has(offset)) return resolved.get(offset)!;
      const raw = rawByOffset.get(offset);
      if (!raw) throw new Error(`No raw object at pack offset ${offset}`);

      let obj: PackObject;

      if (raw.type === 6) {
        // OFS_DELTA
        const baseOff = raw.offset - raw.baseOffset!;
        const base = resolveAt(baseOff);
        const content = applyDelta(base.content, raw.data);
        obj = { sha: hashContent(base.type, content), type: base.type, content };

      } else if (raw.type === 7) {
        // REF_DELTA — look in already-resolved pack objects first, then store
        const base = findResolvedBySha(raw.baseSha!, resolved) ??
                     readFromStore(raw.baseSha!, store);
        const content = applyDelta(base.content, raw.data);
        obj = { sha: hashContent(base.type, content), type: base.type, content };

      } else {
        const type = NUM_TYPE[raw.type] as ObjectType;
        obj = { sha: hashContent(type, raw.data), type, content: raw.data };
      }

      resolved.set(offset, obj);
      return obj;
    };

    for (const raw of rawList) resolveAt(raw.offset);
    return Array.from(resolved.values());
  }
}

// ---- writer ----------------------------------------------------------------

/**
 * Build an undeltified pack from a map of sha → {type, content}.
 * This is always valid — the server will accept it even though it's larger
 * than a delta-compressed pack.
 */
export function buildPackfile(
  objects: Map<string, { type: ObjectType; content: Buffer }>
): Buffer {
  const parts: Buffer[] = [];

  // Header placeholder — we'll fill count after collecting objects
  const header = Buffer.alloc(12);
  PACK_MAGIC.copy(header);
  header.writeUInt32BE(PACK_VERSION, 4);
  header.writeUInt32BE(objects.size, 8);
  parts.push(header);

  for (const [, { type, content }] of objects) {
    parts.push(encodePackObject(TYPE_NUM[type], content));
  }

  const body  = Buffer.concat(parts);
  const trail = crypto.createHash('sha1').update(body).digest();
  return Buffer.concat([body, trail]);
}

// ---- helpers ---------------------------------------------------------------

function encodePackObject(typeNum: number, data: Buffer): Buffer {
  // Variable-length header: more(1) | type(3) | size(4) ...
  const headerBytes: number[] = [];
  let size = data.length;
  let first = true;

  while (size > 0 || first) {
    let byte: number;
    if (first) {
      byte = (typeNum << 4) | (size & 0x0f);
      size >>= 4;
      first = false;
    } else {
      byte = size & 0x7f;
      size >>= 7;
    }
    if (size > 0) byte |= 0x80;
    headerBytes.push(byte);
  }

  const compressed = zlib.deflateSync(data, { level: 1 });
  return Buffer.concat([Buffer.from(headerBytes), compressed]);
}

function inflateAt(buf: Buffer, pos: number): { data: Buffer; consumed: number } {
  // We don't know the exact compressed length, so try increasing windows
  // until inflate succeeds without a truncation error.
  // In practice we scan for the next valid zlib boundary, but for robustness
  // we use the inflateRaw API with Z_SYNC_FLUSH awareness.
  // Simplest correct approach: inflate the rest of the buffer; the decompressor
  // will stop at the end of the zlib stream and track consumed bytes.
  const rest = buf.subarray(pos);
  // Node's zlib doesn't expose consumed bytes directly, so we use the
  // createInflate stream approach via inflateSync on progressively larger slices.
  // More reliable: use the raw binding that returns consumed count.
  return inflateDetect(rest);
}

function inflateDetect(buf: Buffer): { data: Buffer; consumed: number } {
  // Binary search for the correct number of compressed bytes.
  // Start with a window and expand until inflate works without truncation.
  let lo = 2, hi = buf.length;
  let lastGood: { data: Buffer; consumed: number } | null = null;

  // Try the full buffer first (common case, avoids the search loop)
  try {
    const data = zlib.inflateSync(buf);
    // Find exact consumed length by trying smaller slices
    return { data, consumed: findConsumed(buf, data) };
  } catch { /* truncated, search below */ }

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = zlib.inflateSync(buf.subarray(0, mid));
      lastGood = { data, consumed: mid };
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (!lastGood) throw new Error('Could not inflate pack object data');
  return lastGood;
}

function findConsumed(compressed: Buffer, expected: Buffer): number {
  // Work backwards from the known full decompressed size.
  // Try the exact adler32-terminated stream boundary using binary search.
  // This is an approximation — for most objects the compressed size
  // is small enough that scanning from the start works.
  let lo = 2, hi = compressed.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const d = zlib.inflateSync(compressed.subarray(0, mid));
      if (d.equals(expected)) { hi = mid; } else { lo = mid + 1; }
    } catch {
      lo = mid + 1;
    }
  }
  return hi;
}

function hashContent(type: ObjectType, content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\0`);
  return crypto.createHash('sha1').update(Buffer.concat([header, content])).digest('hex');
}

function findResolvedBySha(
  sha: string,
  resolved: Map<number, PackObject>
): PackObject | null {
  for (const obj of resolved.values()) {
    if (obj.sha === sha) return obj;
  }
  return null;
}

function readFromStore(sha: string, store?: ObjectStore): PackObject {
  if (!store) throw new Error(`REF_DELTA base ${sha.slice(0,7)} not in pack and no store provided`);
  if (!store.exists(sha)) throw new Error(`REF_DELTA base ${sha.slice(0,7)} not found in object store`);
  const { type, content } = store.read(sha);
  return { sha, type: type as ObjectType, content };
}
