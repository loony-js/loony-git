/**
 * stash: save and restore working directory changes.
 *
 *   lgit stash [push] [-m <msg>]   Save WD+index state, restore to HEAD
 *   lgit stash pop                  Apply latest stash and remove it
 *   lgit stash list                 List all stashes
 *   lgit stash drop [stash@{N}]     Remove a stash entry
 *   lgit stash show [stash@{N}]     Show diff of a stash entry
 *
 * Storage: stash commits are kept in .git/refs/stash-stack (one SHA per line,
 * newest first). Each stash commit records:
 *   tree     = working-directory snapshot (all tracked + modified files)
 *   parents  = [HEAD at stash time]
 *   message  = "stash@{N}: WIP on <branch>: <sha> <msg>"
 */

import * as fs   from 'fs';
import * as path from 'path';
import { Repository } from '../core/repository';
import { CommitObjectParser } from '../core/objects/commit';
import { TreeObject } from '../core/objects/tree';
import { diffTrees, diffHunks } from '../core/diff';
import { buildNestedTree } from './merge';
import { IndexEntry, TreeEntry } from '../types';

export interface StashOptions {
  sub?:     string;           // 'push'|'pop'|'list'|'drop'|'show'|undefined
  message?: string;
  ref?:     string;           // stash@{N} for drop/show
}

export function stash(repo: Repository, opts: StashOptions = {}): string {
  const sub = opts.sub ?? 'push';
  switch (sub) {
    case 'push': return stashPush(repo, opts.message);
    case 'pop':  return stashPop(repo);
    case 'list': return stashList(repo);
    case 'drop': return stashDrop(repo, opts.ref);
    case 'show': return stashShow(repo, opts.ref);
    default: throw new Error(`stash: unknown subcommand '${sub}'`);
  }
}

// ---- push ------------------------------------------------------------------

function stashPush(repo: Repository, message?: string): string {
  const headSha = repo.refs.resolveHead();
  if (!headSha) throw new Error('stash: nothing to stash — no commits yet');

  // Check if there's anything to stash
  const hasChanges = hasUnstagedOrStagedChanges(repo);
  if (!hasChanges) return 'No local changes to save';

  // Snapshot current working directory (tracked files)
  const snapEntries = snapshotWorkdir(repo);
  const snapTreeSha = buildNestedTree(repo, snapEntries);

  // Build stash message
  const branch = repo.refs.currentBranch() ?? 'HEAD';
  const headCommit = CommitObjectParser.read(repo.store, headSha);
  const headMsg = headCommit.message.split('\n')[0].slice(0, 40);
  const n = readStack(repo).length;
  const msg = message
    ?? `stash@{${n}}: WIP on ${branch}: ${headSha.slice(0, 7)} ${headMsg}`;

  // Create stash commit
  const { name, email } = repo.getAuthor();
  const now = Math.floor(Date.now() / 1000);
  const tz  = new Date().toTimeString().slice(12, 17);

  const stashSha = CommitObjectParser.write(repo.store, {
    tree: snapTreeSha,
    parents: [headSha],
    author:    { name, email, timestamp: now, timezone: tz },
    committer: { name, email, timestamp: now, timezone: tz },
    message: msg,
  });

  // Prepend to stack
  const stack = readStack(repo);
  stack.unshift(stashSha);
  writeStack(repo, stack);

  // Hard-reset working tree and index to HEAD
  hardResetToHead(repo, headSha);

  return `Saved working directory and index state\n${msg}`;
}

// ---- pop -------------------------------------------------------------------

function stashPop(repo: Repository): string {
  const stack = readStack(repo);
  if (stack.length === 0) throw new Error('stash: No stash entries found.');

  const stashSha = stack[0];
  const result = applyStash(repo, stashSha);
  stack.shift();
  writeStack(repo, stack);
  return result + '\nDropped stash@{0}';
}

// ---- list ------------------------------------------------------------------

function stashList(repo: Repository): string {
  const stack = readStack(repo);
  if (stack.length === 0) return '';
  return stack
    .map((sha, i) => {
      const c = CommitObjectParser.read(repo.store, sha);
      const msg = c.message.replace(/^stash@\{\d+\}:\s*/, '').split('\n')[0];
      return `stash@{${i}}: ${msg}`;
    })
    .join('\n');
}

// ---- drop ------------------------------------------------------------------

function stashDrop(repo: Repository, ref?: string): string {
  const stack = readStack(repo);
  if (stack.length === 0) throw new Error('stash: No stash entries found.');
  const idx = parseStashRef(ref ?? 'stash@{0}');
  if (idx >= stack.length) throw new Error(`stash: ${ref}: reference not found`);
  stack.splice(idx, 1);
  writeStack(repo, stack);
  return `Dropped stash@{${idx}}`;
}

// ---- show ------------------------------------------------------------------

function stashShow(repo: Repository, ref?: string): string {
  const stack = readStack(repo);
  if (stack.length === 0) throw new Error('stash: No stash entries found.');
  const idx = parseStashRef(ref ?? 'stash@{0}');
  if (idx >= stack.length) throw new Error(`stash: ${ref}: reference not found`);

  const stashSha = stack[idx];
  const stashCommit = CommitObjectParser.read(repo.store, stashSha);
  const parentCommit = CommitObjectParser.read(repo.store, stashCommit.parents[0]);

  const diffs = diffTrees(repo.store, parentCommit.tree, stashCommit.tree);
  if (diffs.length === 0) return '(no changes)';

  const lines: string[] = [];
  for (const fd of diffs) {
    const oldContent = fd.oldSha ? repo.store.read(fd.oldSha).content.toString('utf8') : '';
    const newContent = fd.newSha ? repo.store.read(fd.newSha).content.toString('utf8') : '';
    lines.push(`diff --git a/${fd.path} b/${fd.path}`);
    lines.push(`--- ${fd.oldSha ? `a/${fd.path}` : '/dev/null'}`);
    lines.push(`+++ ${fd.newSha ? `b/${fd.path}` : '/dev/null'}`);
    const hunks = diffHunks(oldContent, newContent);
    if (hunks.length > 0) lines.push(...hunks);
  }
  return lines.join('\n');
}

// ---- Internal helpers ------------------------------------------------------

function readStack(repo: Repository): string[] {
  const stackPath = path.join(repo.gitDir, 'stash-stack');
  if (!fs.existsSync(stackPath)) return [];
  return fs.readFileSync(stackPath, 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

function writeStack(repo: Repository, stack: string[]): void {
  const stackPath = path.join(repo.gitDir, 'stash-stack');
  fs.writeFileSync(stackPath, stack.join('\n') + (stack.length ? '\n' : ''));
}

function parseStashRef(ref: string): number {
  const m = ref.match(/^stash@\{(\d+)\}$/);
  if (!m) throw new Error(`stash: invalid ref '${ref}'`);
  return parseInt(m[1], 10);
}

/** Snapshot all tracked files from the working directory. */
function snapshotWorkdir(
  repo: Repository,
): { path: string; sha: string; mode: string }[] {
  const entries: { path: string; sha: string; mode: string }[] = [];
  for (const ie of repo.index.getAll()) {
    const abs = path.join(repo.workDir, ie.name);
    if (!fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs);
    const sha = repo.store.write('blob', content);
    const mode = (ie.mode >>> 0).toString(8).padStart(6, '0');
    entries.push({ path: ie.name, sha, mode });
  }
  return entries;
}

/** Check if working tree or index differs from HEAD. */
function hasUnstagedOrStagedChanges(repo: Repository): boolean {
  const headSha = repo.refs.resolveHead();
  if (!headSha) return repo.index.count() > 0;
  const headCommit = CommitObjectParser.read(repo.store, headSha);
  for (const ie of repo.index.getAll()) {
    const abs = path.join(repo.workDir, ie.name);
    if (!fs.existsSync(abs)) return true;
    const content = fs.readFileSync(abs);
    const sha = repo.store.write('blob', content);
    if (sha !== ie.hash) return true;
  }
  // Also check if index differs from HEAD tree
  const { flattenTree } = require('../core/diff');
  const headFiles = flattenTree(repo.store, headCommit.tree) as Map<string, { sha: string }>;
  for (const ie of repo.index.getAll()) {
    const hf = headFiles.get(ie.name);
    if (!hf || hf.sha !== ie.hash) return true;
  }
  return false;
}

/** Reset working tree and index to a given commit (hard reset). */
function hardResetToHead(repo: Repository, headSha: string): void {
  const commit = CommitObjectParser.read(repo.store, headSha);
  const { flattenTree } = require('../core/diff');
  const files = flattenTree(repo.store, commit.tree) as Map<string, { sha: string; mode: string }>;

  // Remove tracked files not in HEAD
  for (const ie of repo.index.getAll()) {
    if (!files.has(ie.name)) {
      const abs = path.join(repo.workDir, ie.name);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
  }

  // Write HEAD files
  for (const [name, { sha, mode }] of files) {
    const abs = path.join(repo.workDir, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, repo.store.read(sha).content, { mode: parseInt(mode, 8) });
  }

  // Rebuild index
  repo.index.clear();
  for (const [name, { sha, mode }] of files) {
    const abs  = path.join(repo.workDir, name);
    const stat = fs.statSync(abs);
    const ie: IndexEntry = {
      ctimeSec:  Math.floor(stat.ctimeMs / 1000),
      ctimeNsec: (stat.ctimeMs % 1000) * 1_000_000,
      mtimeSec:  Math.floor(stat.mtimeMs / 1000),
      mtimeNsec: (stat.mtimeMs % 1000) * 1_000_000,
      dev: stat.dev >>> 0, ino: stat.ino >>> 0,
      mode: parseInt(mode, 8),
      uid: stat.uid >>> 0, gid: stat.gid >>> 0,
      size: stat.size >>> 0, hash: sha, flags: 0, name,
    };
    repo.index.add(ie);
  }
  repo.index.save();
}

/** Apply a stash commit's changes to the current working tree. */
function applyStash(repo: Repository, stashSha: string): string {
  const stashCommit  = CommitObjectParser.read(repo.store, stashSha);
  const parentCommit = CommitObjectParser.read(repo.store, stashCommit.parents[0]);

  const { flattenTree, threeWayMerge } = require('../core/diff');
  const stashFiles  = flattenTree(repo.store, stashCommit.tree)  as Map<string, { sha: string; mode: string }>;
  const parentFiles = flattenTree(repo.store, parentCommit.tree) as Map<string, { sha: string; mode: string }>;
  const headSha = repo.refs.resolveHead()!;
  const headCommit = CommitObjectParser.read(repo.store, headSha);
  const headFiles  = flattenTree(repo.store, headCommit.tree)   as Map<string, { sha: string; mode: string }>;

  const allPaths = [...new Set([...stashFiles.keys(), ...parentFiles.keys(), ...headFiles.keys()])].sort();
  let conflicts = false;

  for (const p of allPaths) {
    const s = stashFiles.get(p)  ?? null;
    const b = parentFiles.get(p) ?? null;
    const h = headFiles.get(p)   ?? null;

    if (!s && !h) continue;

    // No change in stash relative to its parent
    if (s && b && s.sha === b.sha) continue;

    const abs = path.join(repo.workDir, p);

    if (!s) {
      // Stash deleted this file
      if (h && fs.existsSync(abs)) fs.unlinkSync(abs);
    } else {
      const baseContent  = b ? repo.store.read(b.sha).content.toString('utf8') : '';
      const stashContent = repo.store.read(s.sha).content.toString('utf8');
      const headContent  = h ? repo.store.read(h.sha).content.toString('utf8') : '';

      const { result, conflicts: fc } = threeWayMerge(
        baseContent, headContent, stashContent, 'HEAD', 'stash',
      );
      if (fc) conflicts = true;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, result, 'utf8');

      const blobSha = repo.store.write('blob', Buffer.from(result, 'utf8'));
      const stat = fs.statSync(abs);
      const mode = parseInt(s.mode, 8);
      const ie: IndexEntry = {
        ctimeSec:  Math.floor(stat.ctimeMs / 1000),
        ctimeNsec: (stat.ctimeMs % 1000) * 1_000_000,
        mtimeSec:  Math.floor(stat.mtimeMs / 1000),
        mtimeNsec: (stat.mtimeMs % 1000) * 1_000_000,
        dev: stat.dev >>> 0, ino: stat.ino >>> 0, mode,
        uid: stat.uid >>> 0, gid: stat.gid >>> 0,
        size: stat.size >>> 0, hash: blobSha, flags: 0, name: p,
      };
      repo.index.add(ie);
    }
  }
  repo.index.save();

  return conflicts
    ? 'Applied stash (with conflicts; resolve before committing)'
    : 'Applied stash cleanly';
}
