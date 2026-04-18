/**
 * Content-addressable object store.
 *
 * Mirrors Git's loose-object model:
 *   - Header:  "<type> <size>\0"
 *   - Content: raw bytes
 *   - Key:     SHA-1(header + content)
 *   - Storage: zlib-deflate'd at .git/objects/XX/YYYYYY...
 */

import * as crypto from 'crypto';
import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import { ObjectType } from '../../types';

export interface RawObject {
  type: ObjectType;
  content: Buffer;
}

export class ObjectStore {
  constructor(private readonly gitDir: string) {}

  private get objectsDir(): string {
    return path.join(this.gitDir, 'objects');
  }

  // .git/objects/XX/YY...  (XX = first two hex chars)
  objectPath(hash: string): string {
    return path.join(this.objectsDir, hash.slice(0, 2), hash.slice(2));
  }

  // Build the full zlib-compressed payload, return its SHA-1
  hash(type: ObjectType, content: Buffer): string {
    const header = Buffer.from(`${type} ${content.length}\0`);
    return crypto
      .createHash('sha1')
      .update(Buffer.concat([header, content]))
      .digest('hex');
  }

  // Write object to loose object store, return SHA-1
  write(type: ObjectType, content: Buffer): string {
    const sha = this.hash(type, content);
    const dest = this.objectPath(sha);
    if (fs.existsSync(dest)) return sha; // idempotent

    const header = Buffer.from(`${type} ${content.length}\0`);
    const payload = Buffer.concat([header, content]);
    const compressed = zlib.deflateSync(payload, { level: 1 });

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Write atomically via a temp file then rename
    const tmp = `${dest}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, compressed);
    fs.renameSync(tmp, dest);
    return sha;
  }

  // Read and decompress a loose object
  read(hash: string): RawObject {
    const src = this.objectPath(hash);
    if (!fs.existsSync(src)) {
      throw new Error(`Object not found: ${hash}`);
    }
    const compressed = fs.readFileSync(src);
    const raw = zlib.inflateSync(compressed);

    const nullByte = raw.indexOf(0);
    if (nullByte === -1) throw new Error(`Corrupt object header: ${hash}`);

    const header = raw.subarray(0, nullByte).toString('ascii');
    const spaceIdx = header.indexOf(' ');
    const type = header.slice(0, spaceIdx) as ObjectType;
    const size = parseInt(header.slice(spaceIdx + 1), 10);
    const content = raw.subarray(nullByte + 1);

    if (content.length !== size) {
      throw new Error(
        `Object size mismatch for ${hash}: expected ${size}, got ${content.length}`
      );
    }

    return { type, content };
  }

  exists(hash: string): boolean {
    return fs.existsSync(this.objectPath(hash));
  }

  // Return all loose object hashes in the store
  listAll(): string[] {
    const hashes: string[] = [];
    if (!fs.existsSync(this.objectsDir)) return hashes;
    for (const prefix of fs.readdirSync(this.objectsDir)) {
      if (prefix.length !== 2 || !/^[0-9a-f]{2}$/.test(prefix)) continue;
      const prefixDir = path.join(this.objectsDir, prefix);
      for (const suffix of fs.readdirSync(prefixDir)) {
        hashes.push(prefix + suffix);
      }
    }
    return hashes;
  }
}
