/**
 * checkout: switch branches or restore working tree files.
 *
 *   lgit checkout <branch>          switch to existing branch
 *   lgit checkout -b <branch>       create and switch
 *   lgit checkout <commit-sha>      detached HEAD
 *   lgit checkout -- <file>...      restore file from index
 *
 * The three-pointer update rule (same as Git):
 *   1. Resolve target commit → tree
 *   2. Diff current index  vs  target tree
 *   3. Update working directory for changed/added/removed files
 *   4. Replace index entries with target tree
 *   5. Update HEAD
 *
 * Mirrors: git checkout
 */

import * as fs from 'fs';
import * as path from 'path';
import { Repository } from '../core/repository';
import { TreeObject } from '../core/objects/tree';
import { CommitObjectParser } from '../core/objects/commit';
import { BlobObject } from '../core/objects/blob';
import { IndexEntry } from '../types';

export interface CheckoutOptions {
  target: string;        // branch name, commit SHA, or '--'
  createBranch?: boolean;
  files?: string[];      // for `checkout -- <file>`
}

export function checkout(repo: Repository, opts: CheckoutOptions): string {
  // ---- restore files from index -------------------------------------------
  if (opts.target === '--' && opts.files?.length) {
    return restoreFiles(repo, opts.files);
  }

  // ---- resolve target to a commit SHA -------------------------------------
  let commitSha = repo.refs.resolve(opts.target);
  const isNewBranch = opts.createBranch;

  if (!commitSha) {
    // Maybe it's a raw commit SHA
    if (/^[0-9a-f]{7,40}$/.test(opts.target) && repo.store.exists(
      opts.target.length === 40
        ? opts.target
        : repo.store.listAll().find(h => h.startsWith(opts.target)) ?? ''
    )) {
      commitSha = opts.target.length === 40
        ? opts.target
        : repo.store.listAll().find(h => h.startsWith(opts.target))!;
    } else if (!isNewBranch) {
      throw new Error(`error: pathspec '${opts.target}' did not match any known refs`);
    }
  }

  if (isNewBranch) {
    if (repo.refs.branchExists(opts.target)) {
      throw new Error(`fatal: A branch named '${opts.target}' already exists`);
    }
    const base = commitSha ?? repo.refs.resolveHead();
    if (!base) throw new Error('fatal: no commits yet');
    repo.refs.createBranch(opts.target, base);
    commitSha = base;
  }

  if (!commitSha) throw new Error(`fatal: Could not resolve '${opts.target}'`);

  // ---- build flat map of target tree (path → { hash, mode }) -------------
  const commit = CommitObjectParser.read(repo.store, commitSha);
  const targetFiles = new Map<string, { hash: string; mode: number }>();
  flattenTree(repo, commit.tree, '', targetFiles);

  // ---- current index map --------------------------------------------------
  const currentIndex = new Map(repo.index.getAll().map(e => [e.name, e]));

  // ---- update working directory -------------------------------------------
  // Remove files present in current index but absent in target
  for (const [name] of currentIndex) {
    if (!targetFiles.has(name)) {
      const abs = path.join(repo.workDir, name);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      pruneEmptyDirs(path.dirname(abs), repo.workDir);
    }
  }

  // Write / overwrite files from target
  for (const [name, { hash, mode }] of targetFiles) {
    const abs = path.join(repo.workDir, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const blob = BlobObject.read(repo.store, hash);
    fs.writeFileSync(abs, blob.content, { mode });
  }

  // ---- rebuild index from target tree -------------------------------------
  repo.index.clear();
  for (const [name, { hash, mode }] of targetFiles) {
    const abs = path.join(repo.workDir, name);
    const stat = fs.statSync(abs);
    const entry: IndexEntry = {
      ctimeSec:  Math.floor(stat.ctimeMs / 1000),
      ctimeNsec: (stat.ctimeMs % 1000) * 1_000_000,
      mtimeSec:  Math.floor(stat.mtimeMs / 1000),
      mtimeNsec: (stat.mtimeMs % 1000) * 1_000_000,
      dev:  stat.dev  >>> 0,
      ino:  stat.ino  >>> 0,
      mode,
      uid:  stat.uid  >>> 0,
      gid:  stat.gid  >>> 0,
      size: stat.size >>> 0,
      hash,
      flags: 0,
      name,
    };
    repo.index.add(entry);
  }
  repo.index.save();

  // ---- update HEAD --------------------------------------------------------
  const branchRef = `refs/heads/${opts.target}`;
  if (!isNewBranch && repo.refs.branchExists(opts.target)) {
    repo.refs.writeHead({ type: 'symref', ref: branchRef });
    return `Switched to branch '${opts.target}'`;
  } else if (isNewBranch) {
    repo.refs.writeHead({ type: 'symref', ref: branchRef });
    return `Switched to a new branch '${opts.target}'`;
  } else {
    // Detached HEAD
    repo.refs.writeHead({ type: 'sha', hash: commitSha });
    return `HEAD is now at ${commitSha.slice(0, 7)}`;
  }
}

// Restore specific files from the index into the working directory
function restoreFiles(repo: Repository, files: string[]): string {
  for (const file of files) {
    const rel  = file.split(path.sep).join('/');
    const entry = repo.index.get(rel);
    if (!entry) throw new Error(`error: pathspec '${file}' did not match any file(s) known to lgit`);
    const abs  = path.join(repo.workDir, rel);
    const blob = BlobObject.read(repo.store, entry.hash);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, blob.content, { mode: entry.mode });
  }
  return '';
}

function flattenTree(
  repo: Repository,
  treeSha: string,
  prefix: string,
  out: Map<string, { hash: string; mode: number }>
): void {
  const tree = TreeObject.read(repo.store, treeSha);
  for (const e of tree.entries) {
    const full = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '040000') {
      flattenTree(repo, e.hash, full, out);
    } else {
      out.set(full, { hash: e.hash, mode: parseInt(e.mode, 8) });
    }
  }
}

function pruneEmptyDirs(dir: string, root: string): void {
  if (dir === root || !dir.startsWith(root)) return;
  try {
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      pruneEmptyDirs(path.dirname(dir), root);
    }
  } catch { /* ignore */ }
}
