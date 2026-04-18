/**
 * Blob object — raw file contents, no structure.
 * Git stores blobs verbatim; this module is a thin
 * convenience layer for the ObjectStore.
 */

import { ObjectStore } from './store';

export class BlobObject {
  constructor(public readonly content: Buffer) {}

  static fromBuffer(data: Buffer): BlobObject {
    return new BlobObject(data);
  }

  serialize(): Buffer {
    return this.content;
  }

  // Write blob to object store, return SHA-1
  static write(store: ObjectStore, data: Buffer): string {
    return store.write('blob', data);
  }

  static read(store: ObjectStore, hash: string): BlobObject {
    const { type, content } = store.read(hash);
    if (type !== 'blob') throw new Error(`Expected blob, got ${type}`);
    return new BlobObject(content);
  }
}
