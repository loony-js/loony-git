/**
 * add: stage files into the index.
 *
 *   lgit add <pathspec>...
 *   lgit add .           (all files under cwd)
 *
 * For each path:
 *   1. Hash the file content → blob
 *   2. Write blob to object store
 *   3. Add / update the index entry with current stat data
 *
 * Mirrors: git add
 */

import * as fs from 'fs';
import * as path from 'path';
import { Repository } from '../core/repository';
import { BlobObject } from '../core/objects/blob';
import { statToIndexEntry } from '../core/index/index';

export function add(repo: Repository, pathspecs: string[]): void {
  const resolved = pathspecs.map(p => path.resolve(repo.workDir, p));

  const files: string[] = [];
  for (const p of resolved) {
    if (!fs.existsSync(p)) {
      throw new Error(`pathspec '${repo.relativePath(p)}' did not match any files`);
    }
    collect(p, repo.gitDir, files);
  }

  for (const abs of files) {
    const rel = repo.relativePath(abs);
    // Normalise to forward slashes on Windows
    const name = rel.split(path.sep).join('/');

    const content = fs.readFileSync(abs);
    const hash = BlobObject.write(repo.store, content);
    const entry = statToIndexEntry(abs, name, hash);
    repo.index.add(entry);
  }

  repo.index.save();
}

// Recursively collect regular files, skipping .git and unreadable paths
function collect(p: string, gitDir: string, out: string[]): void {
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    if (path.resolve(p) === path.resolve(gitDir)) return;
    for (const child of fs.readdirSync(p)) {
      collect(path.join(p, child), gitDir, out);
    }
  } else if (stat.isFile()) {
    out.push(p);
  }
  // symlinks and other special files are skipped
}
