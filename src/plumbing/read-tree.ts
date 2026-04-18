/**
 * read-tree: load a tree object into the index.
 *
 *   lgit read-tree <tree-sha>
 *
 * Clears the index and repopulates it from the given tree,
 * recursively expanding subtrees. Does NOT touch the working directory.
 *
 * Mirrors: git read-tree
 */

import { Repository } from '../core/repository';
import { TreeObject } from '../core/objects/tree';
import { IndexEntry } from '../types';

export function readTree(repo: Repository, treeSha: string): void {
  repo.index.clear();

  const flatEntries = flattenTree(repo, treeSha, '');
  for (const entry of flatEntries) {
    repo.index.add(entry);
  }

  repo.index.save();
}

function flattenTree(
  repo: Repository,
  treeSha: string,
  prefix: string
): IndexEntry[] {
  const tree = TreeObject.read(repo.store, treeSha);
  const results: IndexEntry[] = [];

  for (const e of tree.entries) {
    const fullPath = prefix ? `${prefix}/${e.name}` : e.name;

    if (e.mode === '040000') {
      // Subdirectory — recurse
      const sub = flattenTree(repo, e.hash, fullPath);
      results.push(...sub);
    } else {
      const modeNum = parseInt(e.mode, 8);
      results.push({
        ctimeSec: 0, ctimeNsec: 0,
        mtimeSec: 0, mtimeNsec: 0,
        dev: 0, ino: 0,
        mode: modeNum,
        uid: 0, gid: 0,
        size: 0,
        hash: e.hash,
        flags: 0,
        name: fullPath,
      });
    }
  }

  return results;
}
