/**
 * write-tree: create a tree object from the current index.
 *
 *   lgit write-tree
 *
 * Walks the index entries, groups them by directory depth,
 * and recursively writes tree objects — exactly as Git does.
 *
 * Mirrors: git write-tree
 */

import * as path from 'path';
import { Repository } from '../core/repository';
import { TreeObject } from '../core/objects/tree';
import { TreeEntry } from '../types';

export function writeTree(repo: Repository): string {
  const entries = repo.index.getAll();
  return buildTree(repo, entries, '');
}

/**
 * Recursively build trees.
 * @param prefix  directory prefix we're currently processing ('' = root)
 */
function buildTree(
  repo: Repository,
  entries: { name: string; hash: string; mode: number }[],
  prefix: string
): string {
  const treeEntries: TreeEntry[] = [];

  // Collect direct children (files) and sub-directory names at this level
  const subdirs = new Set<string>();

  for (const entry of entries) {
    const rel = prefix ? entry.name.slice(prefix.length + 1) : entry.name;
    const slashIdx = rel.indexOf('/');

    if (slashIdx === -1) {
      // Direct child file
      const modeStr = (entry.mode >>> 0).toString(8).padStart(6, '0');
      treeEntries.push({ mode: modeStr, name: rel, hash: entry.hash });
    } else {
      // Belongs to a subdirectory
      subdirs.add(rel.slice(0, slashIdx));
    }
  }

  // Recurse into each subdirectory
  for (const dir of subdirs) {
    const fullDir = prefix ? `${prefix}/${dir}` : dir;
    const subEntries = entries.filter(e => e.name.startsWith(fullDir + '/'));
    const subTreeHash = buildTree(repo, subEntries, fullDir);
    treeEntries.push({ mode: '040000', name: dir, hash: subTreeHash });
  }

  return TreeObject.write(repo.store, treeEntries);
}
