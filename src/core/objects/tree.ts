/**
 * Tree object — maps names to (mode, SHA) entries.
 *
 * Binary wire format (same as real Git):
 *   for each entry (sorted by name):
 *     "<mode> <name>\0<20-byte-binary-sha>"
 *
 * Modes:
 *   100644  regular file
 *   100755  executable
 *   40000   directory  (note: no leading zero on disk)
 *   120000  symlink
 *   160000  gitlink
 */

import { TreeEntry } from '../../types';
import { ObjectStore } from './store';

export class TreeObject {
  constructor(public readonly entries: TreeEntry[]) {}

  serialize(): Buffer {
    // Git sorts tree entries: directories sort as if their name ends with '/'
    const sorted = [...this.entries].sort((a, b) => {
      const an = a.mode === '40000' ? a.name + '/' : a.name;
      const bn = b.mode === '40000' ? b.name + '/' : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    const parts: Buffer[] = [];
    for (const entry of sorted) {
      // mode (no leading zeros for directories: '40000' not '040000')
      const modeStr = entry.mode.replace(/^0+/, '') || '0';
      const header = Buffer.from(`${modeStr} ${entry.name}\0`);
      const sha = Buffer.from(entry.hash, 'hex'); // 20 bytes
      parts.push(header, sha);
    }
    return Buffer.concat(parts);
  }

  static deserialize(data: Buffer): TreeObject {
    const entries: TreeEntry[] = [];
    let i = 0;

    while (i < data.length) {
      // Read mode (ASCII digits up to space)
      let spaceIdx = data.indexOf(0x20, i);
      const mode = data.subarray(i, spaceIdx).toString('ascii');
      i = spaceIdx + 1;

      // Read name (until NUL)
      const nullIdx = data.indexOf(0x00, i);
      const name = data.subarray(i, nullIdx).toString('utf8');
      i = nullIdx + 1;

      // Read 20-byte binary SHA
      const sha = data.subarray(i, i + 20).toString('hex');
      i += 20;

      // Normalise mode to 6 digits
      const paddedMode = mode.padStart(6, '0');
      entries.push({ mode: paddedMode, name, hash: sha });
    }

    return new TreeObject(entries);
  }

  static write(store: ObjectStore, entries: TreeEntry[]): string {
    const tree = new TreeObject(entries);
    return store.write('tree', tree.serialize());
  }

  static read(store: ObjectStore, hash: string): TreeObject {
    const { type, content } = store.read(hash);
    if (type !== 'tree') throw new Error(`Expected tree, got ${type}`);
    return TreeObject.deserialize(content);
  }
}
