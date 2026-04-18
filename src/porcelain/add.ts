/**
 * add: stage files into the index.
 *
 *   lgit add <pathspec>...
 *   lgit add .           (all files under cwd)
 *
 * For each path:
 *   1. Check against .gitignore rules (skip if ignored, unless explicitly named)
 *   2. Hash the file content → blob
 *   3. Write blob to object store
 *   4. Add / update the index entry with current stat data
 *
 * Mirrors: git add
 */

import * as fs from 'fs';
import * as path from 'path';
import { Repository } from '../core/repository';
import { BlobObject } from '../core/objects/blob';
import { statToIndexEntry } from '../core/index/index';
import { GitIgnore } from '../core/ignore';

export function add(repo: Repository, pathspecs: string[]): void {
  const resolved = pathspecs.map(p => path.resolve(repo.workDir, p));

  // Build ignore rules — only used when recursing into directories.
  // Explicitly named files bypass ignore (matches real Git behaviour).
  const ignore = new GitIgnore(repo.workDir, repo.gitDir);
  ignore.loadAll(repo.config.get('core', 'excludesFile'));

  const files: string[] = [];
  for (const p of resolved) {
    if (!fs.existsSync(p)) {
      throw new Error(`pathspec '${repo.relativePath(p)}' did not match any files`);
    }
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      // Directory pathspec: respect ignore rules
      collect(p, repo.gitDir, repo.workDir, ignore, files);
    } else {
      // Explicit file: always stage, even if it matches a .gitignore pattern
      files.push(p);
    }
  }

  for (const abs of files) {
    const rel  = repo.relativePath(abs);
    const name = rel.split(path.sep).join('/');

    const content = fs.readFileSync(abs);
    const hash    = BlobObject.write(repo.store, content);
    const entry   = statToIndexEntry(abs, name, hash);
    repo.index.add(entry);
  }

  repo.index.save();
}

// Recursively collect regular files, honouring .gitignore and skipping .git
function collect(
  dir: string,
  gitDir: string,
  workDir: string,
  ignore: GitIgnore,
  out: string[]
): void {
  if (path.resolve(dir) === path.resolve(gitDir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(workDir, abs).split(path.sep).join('/');

    if (entry.isDirectory()) {
      if (ignore.isIgnored(rel, true)) continue;
      collect(abs, gitDir, workDir, ignore, out);
    } else if (entry.isFile()) {
      if (ignore.isIgnored(rel, false)) continue;
      out.push(abs);
    }
  }
}
