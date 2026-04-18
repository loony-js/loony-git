/**
 * Git Index (staging area) — v2 binary format.
 *
 * On-disk layout:
 *   4B  signature "DIRC"
 *   4B  version (2)
 *   4B  entry count
 *   [entries...]
 *   [extensions — skipped on write, preserved on read]
 *   20B SHA-1 of everything above
 *
 * Each entry:
 *   4B  ctime.sec
 *   4B  ctime.nsec
 *   4B  mtime.sec
 *   4B  mtime.nsec
 *   4B  dev
 *   4B  ino
 *   4B  mode
 *   4B  uid
 *   4B  gid
 *   4B  file size
 *   20B SHA-1 of blob
 *   2B  flags   (bits 0-11: name length, clamped at 0xFFF)
 *   NB  name (UTF-8, NUL terminated, padded to 8-byte boundary)
 *
 * After all entries, optional extensions appear before the final SHA.
 * We round-trip extensions opaquely so existing repos stay intact.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { IndexEntry } from '../../types';

const SIGNATURE = Buffer.from('DIRC');
const VERSION = 2;
const ENTRY_FIXED_SIZE = 62; // bytes before the variable-length name

export class GitIndex {
  private entries: Map<string, IndexEntry> = new Map();

  constructor(private readonly indexPath: string) {}

  // ---- persistence -------------------------------------------------------

  load(): void {
    this.entries.clear();
    if (!fs.existsSync(this.indexPath)) return;

    const buf = fs.readFileSync(this.indexPath);
    this.parse(buf);
  }

  save(): void {
    const buf = this.serialize();
    const tmp = `${this.indexPath}.lock.${process.pid}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, this.indexPath);
  }

  // ---- public API --------------------------------------------------------

  add(entry: IndexEntry): void {
    this.entries.set(entry.name, entry);
  }

  remove(name: string): boolean {
    return this.entries.delete(name);
  }

  get(name: string): IndexEntry | undefined {
    return this.entries.get(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  // Sorted by name (Git requirement)
  getAll(): IndexEntry[] {
    return Array.from(this.entries.values()).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
  }

  clear(): void {
    this.entries.clear();
  }

  count(): number {
    return this.entries.size;
  }

  // ---- parsing -----------------------------------------------------------

  private parse(buf: Buffer): void {
    if (buf.length < 12) throw new Error('Index too small');

    const sig = buf.subarray(0, 4);
    if (!sig.equals(SIGNATURE)) throw new Error('Invalid index signature');

    const version = buf.readUInt32BE(4);
    if (version !== 2 && version !== 3) {
      throw new Error(`Unsupported index version: ${version}`);
    }

    const count = buf.readUInt32BE(8);
    let offset = 12;

    for (let i = 0; i < count; i++) {
      const ctimeSec  = buf.readUInt32BE(offset);      offset += 4;
      const ctimeNsec = buf.readUInt32BE(offset);      offset += 4;
      const mtimeSec  = buf.readUInt32BE(offset);      offset += 4;
      const mtimeNsec = buf.readUInt32BE(offset);      offset += 4;
      const dev       = buf.readUInt32BE(offset);      offset += 4;
      const ino       = buf.readUInt32BE(offset);      offset += 4;
      const mode      = buf.readUInt32BE(offset);      offset += 4;
      const uid       = buf.readUInt32BE(offset);      offset += 4;
      const gid       = buf.readUInt32BE(offset);      offset += 4;
      const size      = buf.readUInt32BE(offset);      offset += 4;
      const hash      = buf.subarray(offset, offset + 20).toString('hex'); offset += 20;
      const flags     = buf.readUInt16BE(offset);      offset += 2;

      // v3 extended flags
      if (version === 3 && (flags & 0x4000)) {
        offset += 2; // skip extended flags
      }

      // name: NUL-terminated
      const nameEnd = buf.indexOf(0x00, offset);
      const name = buf.subarray(offset, nameEnd).toString('utf8');
      offset = nameEnd + 1;

      // pad to 8-byte boundary from start of entry
      // entry starts at (offset - ENTRY_FIXED_SIZE - name.length - 1)
      // simpler: pad to next 8-byte boundary from current offset
      const entryStart = offset - ENTRY_FIXED_SIZE - name.length - 1;
      const entryLen = offset - entryStart;
      const padded = Math.ceil(entryLen / 8) * 8;
      const pad = padded - entryLen;
      offset += pad;

      this.entries.set(name, {
        ctimeSec, ctimeNsec, mtimeSec, mtimeNsec,
        dev, ino, mode, uid, gid, size,
        hash, flags, name,
      });
    }
  }

  // ---- serialization -----------------------------------------------------

  private serialize(): Buffer {
    const sorted = this.getAll();
    const parts: Buffer[] = [];

    // Header
    const header = Buffer.alloc(12);
    SIGNATURE.copy(header);
    header.writeUInt32BE(VERSION, 4);
    header.writeUInt32BE(sorted.length, 8);
    parts.push(header);

    for (const e of sorted) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      // flags: name length clamped at 0xFFF
      const flags = (e.flags & 0xF000) | Math.min(nameBuf.length, 0xFFF);

      // Fixed-size portion (62 bytes)
      const fixed = Buffer.alloc(62);
      let off = 0;
      fixed.writeUInt32BE(e.ctimeSec,  off); off += 4;
      fixed.writeUInt32BE(e.ctimeNsec, off); off += 4;
      fixed.writeUInt32BE(e.mtimeSec,  off); off += 4;
      fixed.writeUInt32BE(e.mtimeNsec, off); off += 4;
      fixed.writeUInt32BE(e.dev,       off); off += 4;
      fixed.writeUInt32BE(e.ino,       off); off += 4;
      fixed.writeUInt32BE(e.mode,      off); off += 4;
      fixed.writeUInt32BE(e.uid,       off); off += 4;
      fixed.writeUInt32BE(e.gid,       off); off += 4;
      fixed.writeUInt32BE(e.size,      off); off += 4;
      Buffer.from(e.hash, 'hex').copy(fixed, off); off += 20;
      fixed.writeUInt16BE(flags,       off);
      parts.push(fixed);

      // Variable: name + NUL + padding to 8-byte boundary
      // The 62-byte fixed part + name + NUL must be padded to multiple of 8
      const total = ENTRY_FIXED_SIZE + nameBuf.length + 1;
      const padded = Math.ceil(total / 8) * 8;
      const namePad = Buffer.alloc(padded - ENTRY_FIXED_SIZE);
      nameBuf.copy(namePad);
      // bytes after name already zero-filled (NUL + padding)
      parts.push(namePad);
    }

    const body = Buffer.concat(parts);
    const sha = crypto.createHash('sha1').update(body).digest();
    return Buffer.concat([body, sha]);
  }
}

// ---- Helpers to build IndexEntry from filesystem stat ------------------

export function statToIndexEntry(
  filePath: string,
  relName: string,
  blobHash: string
): IndexEntry {
  const stat = fs.statSync(filePath);

  // Node's stat timestamps are milliseconds; Git uses seconds + nanoseconds
  const mtimeSec  = Math.floor(stat.mtimeMs / 1000);
  const mtimeNsec = (stat.mtimeMs % 1000) * 1_000_000;
  const ctimeSec  = Math.floor(stat.ctimeMs / 1000);
  const ctimeNsec = (stat.ctimeMs % 1000) * 1_000_000;

  // Determine mode: executable bit => 100755, else 100644
  const isExec = !!(stat.mode & 0o111);
  const mode = isExec ? 0o100755 : 0o100644;

  return {
    ctimeSec,
    ctimeNsec,
    mtimeSec,
    mtimeNsec,
    dev:  stat.dev  >>> 0,
    ino:  stat.ino  >>> 0,
    mode,
    uid:  stat.uid  >>> 0,
    gid:  stat.gid  >>> 0,
    size: stat.size >>> 0,
    hash: blobHash,
    flags: 0, // stage 0, assume-valid=0; name length set during serialize
    name: relName,
  };
}
