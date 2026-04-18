/**
 * reset: move HEAD (and optionally index + workdir) to a commit.
 *
 *   lgit reset [--soft | --mixed | --hard] [<commit>]
 *   lgit reset HEAD <file>...        unstage specific files
 *
 * --soft   Move HEAD only
 * --mixed  Move HEAD + reset index     (default)
 * --hard   Move HEAD + reset index + reset workdir
 *
 * Mirrors: git reset
 */

import * as fs from 'fs';
import * as path from 'path';
import { Repository } from '../core/repository';
import { revParse } from '../core/revision';
import { CommitObjectParser } from '../core/objects/commit';
import { TreeObject } from '../core/objects/tree';
import { BlobObject } from '../core/objects/blob';
import { IndexEntry } from '../types';

export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface ResetOptions {
  mode: ResetMode;
  target?: string;   // commit-ish; defaults to HEAD
  files?: string[];  // if set, unstage only these files
}

export function reset(repo: Repository, opts: ResetOptions): string {
  // ---- Unstage specific files (git reset HEAD <file>) ---------------------
  if (opts.files?.length) {
    return unstageFiles(repo, opts.files);
  }

  // ---- Resolve target commit ----------------------------------------------
  const targetStr = opts.target ?? 'HEAD';
  const commitSha = revParse(repo, targetStr);

  const targetCommit = CommitObjectParser.read(repo.store, commitSha);

  // ---- 1. Move branch ref / HEAD -----------------------------------------
  const head = repo.refs.readHead();
  if (head.type === 'symref') {
    repo.refs.updateRef(head.ref, commitSha);
  } else {
    repo.refs.writeHead({ type: 'sha', hash: commitSha });
  }

  if (opts.mode === 'soft') {
    return `HEAD is now at ${commitSha.slice(0, 7)}`;
  }

  // ---- 2. Reset index from target tree (mixed + hard) --------------------
  const treeFiles = new Map<string, { hash: string; mode: number }>();
  flattenTree(repo, targetCommit.tree, '', treeFiles);

  repo.index.clear();
  for (const [name, { hash, mode }] of treeFiles) {
    repo.index.add({
      ctimeSec: 0, ctimeNsec: 0,
      mtimeSec: 0, mtimeNsec: 0,
      dev: 0, ino: 0, mode,
      uid: 0, gid: 0, size: 0,
      hash, flags: 0, name,
    } as IndexEntry);
  }
  repo.index.save();

  if (opts.mode === 'mixed') {
    return `HEAD is now at ${commitSha.slice(0, 7)}\nUnstaged changes after reset`;
  }

  // ---- 3. Reset working directory (hard) ----------------------------------
  // Remove everything tracked (current workdir) not in target
  const allWorkFiles = new Set<string>();
  collectWorkdir(repo.workDir, repo.gitDir, allWorkFiles, repo.workDir);

  for (const rel of allWorkFiles) {
    if (!treeFiles.has(rel)) {
      fs.unlinkSync(path.join(repo.workDir, rel));
    }
  }

  for (const [name, { hash, mode }] of treeFiles) {
    const abs = path.join(repo.workDir, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const blob = BlobObject.read(repo.store, hash);
    fs.writeFileSync(abs, blob.content, { mode });
  }

  return `HEAD is now at ${commitSha.slice(0, 7)}`;
}

// Unstage specific files: reset their index entry to what HEAD has
function unstageFiles(repo: Repository, files: string[]): string {
  const headSha = repo.refs.resolveHead();
  const headTree = new Map<string, { hash: string; mode: number }>();

  if (headSha) {
    const c = CommitObjectParser.read(repo.store, headSha);
    flattenTree(repo, c.tree, '', headTree);
  }

  for (const file of files) {
    const rel = file.split(path.sep).join('/');
    const inHead = headTree.get(rel);
    if (inHead) {
      repo.index.add({
        ctimeSec: 0, ctimeNsec: 0,
        mtimeSec: 0, mtimeNsec: 0,
        dev: 0, ino: 0,
        mode: inHead.mode,
        uid: 0, gid: 0, size: 0,
        hash: inHead.hash,
        flags: 0,
        name: rel,
      } as IndexEntry);
    } else {
      repo.index.remove(rel);
    }
  }

  repo.index.save();
  return `Unstaged changes after reset:\nM\t${files.join('\nM\t')}`;
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

function collectWorkdir(
  dir: string,
  gitDir: string,
  out: Set<string>,
  root: string
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (path.resolve(abs) === path.resolve(gitDir)) continue;
    if (entry.isDirectory()) collectWorkdir(abs, gitDir, out, root);
    else if (entry.isFile()) out.add(path.relative(root, abs).split(path.sep).join('/'));
  }
}
