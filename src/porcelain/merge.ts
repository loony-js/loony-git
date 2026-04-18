/**
 * merge: join two commit histories.
 *
 *   lgit merge <branch>
 *   lgit merge --no-ff <branch>
 *
 * Strategy:
 *   - Fast-forward when HEAD is an ancestor of the target (unless --no-ff)
 *   - Otherwise, three-way merge at the tree level using the merge-base as base
 *   - Conflict markers are written to working tree; user must resolve + commit
 */

import * as fs   from 'fs';
import * as path from 'path';
import { Repository } from '../core/repository';
import { CommitObjectParser } from '../core/objects/commit';
import { TreeObject } from '../core/objects/tree';
import { BlobObject } from '../core/objects/blob';
import { revParse } from '../core/revision';
import { flattenTree, threeWayMerge } from '../core/diff';
import { IndexEntry, TreeEntry } from '../types';

export interface MergeOptions {
  branch:   string;
  message?: string;
  noFf?:    boolean;
}

export function merge(repo: Repository, opts: MergeOptions): string {
  const headSha = repo.refs.resolveHead();
  if (!headSha) throw new Error('fatal: nothing to merge into — no commits yet');

  let theirSha: string;
  try { theirSha = revParse(repo, opts.branch); }
  catch { throw new Error(`merge: '${opts.branch}' — not something we can merge`); }

  if (headSha === theirSha) return 'Already up to date.';

  const base = findMergeBase(repo, headSha, theirSha);

  // ---- Fast-forward -------------------------------------------------------
  if (base === headSha && !opts.noFf) {
    advanceHead(repo, theirSha);
    const theirCommit = CommitObjectParser.read(repo.store, theirSha);
    checkoutTreeToWorkdir(repo, theirCommit.tree);
    return `Fast-forward\n (${headSha.slice(0, 7)}..${theirSha.slice(0, 7)})`;
  }

  if (base === theirSha) return 'Already up to date.';

  // ---- Three-way merge ----------------------------------------------------
  const ourCommit   = CommitObjectParser.read(repo.store, headSha);
  const theirCommit = CommitObjectParser.read(repo.store, theirSha);
  const baseTreeSha = base ? CommitObjectParser.read(repo.store, base).tree : null;

  const ourFiles   = flattenTree(repo.store, ourCommit.tree);
  const theirFiles = flattenTree(repo.store, theirCommit.tree);
  const baseFiles  = baseTreeSha
    ? flattenTree(repo.store, baseTreeSha)
    : new Map<string, { sha: string; mode: string }>();

  const allPaths = [...new Set([...ourFiles.keys(), ...theirFiles.keys(), ...baseFiles.keys()])].sort();
  const merged:  { path: string; sha: string; mode: string }[] = [];
  let hasConflicts = false;
  const currentBranch = repo.refs.currentBranch() ?? 'HEAD';

  for (const filePath of allPaths) {
    const o = ourFiles.get(filePath)   ?? null;
    const t = theirFiles.get(filePath) ?? null;
    const b = baseFiles.get(filePath)  ?? null;

    // Both deleted
    if (!o && !t) continue;

    // Only one side has it (or deleted)
    if (!o && t) {
      if (!b || b.sha !== t.sha) merged.push({ path: filePath, sha: t.sha, mode: t.mode });
      continue;
    }
    if (o && !t) {
      if (!b || b.sha !== o.sha) merged.push({ path: filePath, sha: o.sha, mode: o.mode });
      continue;
    }

    // Both have it
    if (o!.sha === t!.sha) { merged.push({ path: filePath, sha: o!.sha, mode: o!.mode }); continue; }

    // Content diverged — 3-way merge
    const baseContent  = b  ? repo.store.read(b.sha).content.toString('utf8')  : '';
    const ourContent   = o  ? repo.store.read(o!.sha).content.toString('utf8') : '';
    const theirContent = t  ? repo.store.read(t!.sha).content.toString('utf8') : '';

    const { result, conflicts } = threeWayMerge(
      baseContent, ourContent, theirContent, currentBranch, opts.branch,
    );

    if (conflicts) hasConflicts = true;

    const blobSha = repo.store.write('blob', Buffer.from(result, 'utf8'));
    merged.push({ path: filePath, sha: blobSha, mode: o!.mode });

    const abs = path.join(repo.workDir, filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, result, 'utf8');
  }

  // Write all non-conflicted files to working tree
  for (const entry of merged) {
    const abs = path.join(repo.workDir, entry.path);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, repo.store.read(entry.sha).content);
    }
  }

  // Rebuild index
  repo.index.clear();
  for (const entry of merged) {
    const abs  = path.join(repo.workDir, entry.path);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    const ie: IndexEntry = {
      ctimeSec:  Math.floor(stat.ctimeMs / 1000),
      ctimeNsec: (stat.ctimeMs % 1000) * 1_000_000,
      mtimeSec:  Math.floor(stat.mtimeMs / 1000),
      mtimeNsec: (stat.mtimeMs % 1000) * 1_000_000,
      dev: stat.dev >>> 0, ino: stat.ino >>> 0,
      mode: parseInt(entry.mode, 8),
      uid: stat.uid >>> 0, gid: stat.gid >>> 0,
      size: stat.size >>> 0,
      hash: entry.sha, flags: 0, name: entry.path,
    };
    repo.index.add(ie);
  }
  repo.index.save();

  if (hasConflicts) {
    return 'Automatic merge failed; fix conflicts and then commit.';
  }

  // Build merged tree and create merge commit
  const mergedTreeSha = buildNestedTree(repo, merged);
  const msg = opts.message
    ?? `Merge branch '${opts.branch}' into ${currentBranch}`;

  const { name, email } = repo.getAuthor();
  const now = Math.floor(Date.now() / 1000);
  const tz  = new Date().toTimeString().slice(12, 17);

  const mergeCommitSha = CommitObjectParser.write(repo.store, {
    tree: mergedTreeSha, parents: [headSha, theirSha],
    author:    { name, email, timestamp: now, timezone: tz },
    committer: { name, email, timestamp: now, timezone: tz },
    message: msg,
  });

  advanceHead(repo, mergeCommitSha);
  return `Merge made by the 'ort' strategy.\n (${headSha.slice(0, 7)}..${mergeCommitSha.slice(0, 7)})`;
}

// ---- Helpers ---------------------------------------------------------------

function findMergeBase(repo: Repository, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const q = [a];
  while (q.length > 0) {
    const sha = q.shift()!;
    if (ancestorsA.has(sha) || !repo.store.exists(sha)) continue;
    ancestorsA.add(sha);
    const c = CommitObjectParser.read(repo.store, sha);
    for (const p of c.parents) q.push(p);
  }

  const visited = new Set<string>();
  const bfs = [b];
  while (bfs.length > 0) {
    const sha = bfs.shift()!;
    if (visited.has(sha)) continue;
    visited.add(sha);
    if (ancestorsA.has(sha)) return sha;
    if (!repo.store.exists(sha)) continue;
    const c = CommitObjectParser.read(repo.store, sha);
    for (const p of c.parents) bfs.push(p);
  }
  return null;
}

function advanceHead(repo: Repository, sha: string): void {
  const head = repo.refs.readHead();
  if (head.type === 'symref') repo.refs.updateRef(head.ref, sha);
  else repo.refs.writeHead({ type: 'sha', hash: sha });
}

function checkoutTreeToWorkdir(repo: Repository, treeSha: string): void {
  const files = new Map<string, { hash: string; mode: number }>();
  flattenForCheckout(repo, treeSha, '', files);

  // Remove files no longer present
  for (const e of repo.index.getAll()) {
    if (!files.has(e.name)) {
      const abs = path.join(repo.workDir, e.name);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
  }

  // Write new/changed files
  for (const [name, { hash, mode }] of files) {
    const abs = path.join(repo.workDir, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, BlobObject.read(repo.store, hash).content, { mode });
  }

  // Rebuild index
  repo.index.clear();
  for (const [name, { hash, mode }] of files) {
    const abs  = path.join(repo.workDir, name);
    const stat = fs.statSync(abs);
    repo.index.add({
      ctimeSec:  Math.floor(stat.ctimeMs / 1000),
      ctimeNsec: (stat.ctimeMs % 1000) * 1_000_000,
      mtimeSec:  Math.floor(stat.mtimeMs / 1000),
      mtimeNsec: (stat.mtimeMs % 1000) * 1_000_000,
      dev: stat.dev >>> 0, ino: stat.ino >>> 0, mode,
      uid: stat.uid >>> 0, gid: stat.gid >>> 0,
      size: stat.size >>> 0, hash, flags: 0, name,
    });
  }
  repo.index.save();
}

function flattenForCheckout(
  repo: Repository,
  treeSha: string,
  prefix: string,
  out: Map<string, { hash: string; mode: number }>,
): void {
  const tree = TreeObject.read(repo.store, treeSha);
  for (const e of tree.entries) {
    const full = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '040000') flattenForCheckout(repo, e.hash, full, out);
    else out.set(full, { hash: e.hash, mode: parseInt(e.mode, 8) });
  }
}

/** Build a nested tree object from flat path→{sha,mode} entries. */
export function buildNestedTree(
  repo: Repository,
  entries: { path: string; sha: string; mode: string }[],
): string {
  const top = new Map<string, TreeEntry | { subtree: typeof entries }>();

  for (const e of entries) {
    const slash = e.path.indexOf('/');
    if (slash === -1) {
      top.set(e.path, { mode: e.mode, name: e.path, hash: e.sha } as TreeEntry);
    } else {
      const dir  = e.path.slice(0, slash);
      const rest = e.path.slice(slash + 1);
      if (!top.has(dir)) top.set(dir, { subtree: [] });
      ((top.get(dir) as any).subtree as typeof entries).push({ ...e, path: rest });
    }
  }

  const treeEntries: TreeEntry[] = [];
  for (const [name, val] of top) {
    if ('subtree' in val) {
      const subSha = buildNestedTree(repo, (val as any).subtree);
      treeEntries.push({ mode: '040000', name, hash: subSha });
    } else {
      treeEntries.push(val as TreeEntry);
    }
  }
  return TreeObject.write(repo.store, treeEntries);
}
